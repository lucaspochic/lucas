import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { journalEntries, journalLines } from "@/server/db/schema";
import { listVatRates, updateCompany } from "@/server/services/companies";
import { createThirdParty } from "@/server/services/third-parties";
import { createCreditNoteDraft, createDraft, issueDocument } from "@/server/services/sales";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { createExpense, payExpense, validateExpense } from "@/server/services/expenses";
import { loadCompany, postSalesDocument } from "@/server/services/accounting";
import { checkLedger, exportFec, fiscalYearBounds, generalLedger, listEntries, trialBalance } from "@/server/services/accounting-reports";
import type { CompanyContext } from "@/server/security/permissions";
import { createTestDb, createUserWithCompany } from "../helpers/db";

const NOW = new Date("2026-10-21T10:00:00Z");
let h: DbHandle;

async function dbError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} | ${e.cause?.message ?? ""}`;
  }
  throw new Error("La requête aurait dû être refusée.");
}

async function setupCompany(name: string, overrides: Record<string, unknown> = {}) {
  const c = await createUserWithCompany(h, name);
  await updateCompany(h.db, c.ctx, {
    legalName: `${name} SAS`,
    siren: "732829320",
    vatNumber: "FR44732829320",
    addressLine1: "1 rue",
    postalCode: "69001",
    city: "Lyon",
    paymentTermsDays: 30,
    latePenaltyText: "Pénalités.",
    invoicePrefix: "FA",
    creditNotePrefix: "AV",
    quotePrefix: "DE",
    ...overrides,
  });
  const rates = await listVatRates(h.db, c.ctx);
  const customer = await createThirdParty(h.db, c.ctx, { partyType: "individual", name: "Jeanne Client", billingLine1: "2 rue", billingCity: "Lyon" });
  const supplier = await createThirdParty(h.db, c.ctx, { partyType: "business", name: "Fournisseur SA", isCustomer: false, isSupplier: true });
  return { ...c, rates, customer, supplier };
}

async function entryLines(ctx: CompanyContext, sourceKey: string) {
  return h.db
    .select({ account: journalLines.accountNumber, debit: journalLines.debit, credit: journalLines.credit, aux: journalLines.auxNumber, journal: journalEntries.journalCode })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceKey, sourceKey)))
    .orderBy(journalLines.lineNo);
}

async function accountBalance(ctx: CompanyContext, account: string) {
  const [r] = await h.db
    .select({ b: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::text` })
    .from(journalLines)
    .where(and(eq(journalLines.companyId, ctx.companyId), eq(journalLines.accountNumber, account)));
  return Number(r!.b).toFixed(2);
}

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("ventes", () => {
  it("facture mixte avec remise globale (TVA sur les débits) : ventilation exacte et équilibrée", async () => {
    const c = await setupCompany("Debits", { vatOnDebits: true });
    const r20 = c.rates.find((r) => r.rate === "20.00")!.id;
    const r55 = c.rates.find((r) => r.rate === "5.50")!.id;
    const draft = await createDraft(h.db, c.ctx, "invoice", {
      thirdPartyId: c.customer.id,
      globalDiscountPercent: "10",
      lines: [
        { description: "Conseil", kind: "service", quantity: "3", unit: "heure", unitPriceExclTax: "83.33", vatRateId: r20 },
        { description: "Livre", kind: "good", quantity: "2", unit: "unité", unitPriceExclTax: "19.99", vatRateId: r55 },
      ],
    });
    const inv = await issueDocument(h.db, c.ctx, draft.id, { now: NOW });
    const lines = await entryLines(c.ctx, `sales:${inv.id}`);
    // 3 × 83,33 = 249,99 → −10 % = 224,99 ; 2 × 19,99 = 39,98 → 35,98 ; TVA 45,00 et 1,98 ; TTC 307,95
    expect(lines).toEqual([
      { account: "411000", debit: "307.95", credit: "0.00", aux: "C00001", journal: "VE" },
      { account: "706000", debit: "0.00", credit: "224.99", aux: null, journal: "VE" },
      { account: "707000", debit: "0.00", credit: "35.98", aux: null, journal: "VE" },
      { account: "445711", debit: "0.00", credit: "45.00", aux: null, journal: "VE" },
      { account: "445713", debit: "0.00", credit: "1.98", aux: null, journal: "VE" },
    ]);
    expect(inv.totalInclTax).toBe("307.95");
  });

  it("TVA sur encaissements : en attente à la facture, exigible au fil des règlements, contre-passation", async () => {
    const c = await setupCompany("Encaissements"); // pas d'option sur les débits
    const r20 = c.rates.find((r) => r.rate === "20.00")!.id;
    const draft = await createDraft(h.db, c.ctx, "invoice", {
      thirdPartyId: c.customer.id,
      lines: [
        { description: "Prestation", kind: "service", quantity: "1", unit: "forfait", unitPriceExclTax: "100", vatRateId: r20 },
        { description: "Fourniture", kind: "good", quantity: "1", unit: "unité", unitPriceExclTax: "50", vatRateId: r20 },
      ],
    });
    const inv = await issueDocument(h.db, c.ctx, draft.id, { now: NOW }); // 180 TTC ; TVA 20 services + 10 biens
    expect(await accountBalance(c.ctx, "445741")).toBe("-20.00"); // en attente (crédit)
    expect(await accountBalance(c.ctx, "445711")).toBe("-10.00"); // biens : exigible à la facture

    const pay = (amount: string) =>
      recordPayment(
        h.db,
        c.ctx,
        { idempotencyKey: randomUUID(), kind: "receipt", thirdPartyId: c.customer.id, paymentDate: "2026-10-21", method: "transfer", amount, allocations: [{ documentId: inv.id, amount }] },
        { now: NOW },
      );
    const p1 = await pay("60"); // 1/3 de 180 → 6,67 de TVA transférée
    expect(await entryLines(c.ctx, `payment:${p1.result.id}`)).toEqual([
      { account: "512000", debit: "60.00", credit: "0.00", aux: null, journal: "BQ1" },
      { account: "411000", debit: "0.00", credit: "60.00", aux: "C00001", journal: "BQ1" },
    ]);
    expect(await accountBalance(c.ctx, "445741")).toBe("-13.33");
    await pay("120"); // solde : transfert du restant exact
    expect(await accountBalance(c.ctx, "445741")).toBe("0.00");
    expect(await accountBalance(c.ctx, "445711")).toBe("-30.00");

    await reversePayment(h.db, c.ctx, p1.result.id, { idempotencyKey: randomUUID(), reason: "Chèque impayé" }, { now: NOW });
    expect(await accountBalance(c.ctx, "445741")).toBe("-6.67");
    expect(await accountBalance(c.ctx, "445711")).toBe("-23.33");
    expect(await accountBalance(c.ctx, "411000")).toBe("60.00");
  });

  it("un avoir contrepasse la facture ; la comptabilisation est idempotente", async () => {
    const c = await setupCompany("Avoirs", { vatOnDebits: true });
    const r20 = c.rates.find((r) => r.rate === "20.00")!.id;
    const inv = await issueDocument(
      h.db,
      c.ctx,
      (await createDraft(h.db, c.ctx, "invoice", { thirdPartyId: c.customer.id, lines: [{ description: "X", kind: "good", quantity: "1", unit: "unité", unitPriceExclTax: "100", vatRateId: r20 }] })).id,
      { now: NOW },
    );
    const credit = await issueDocument(h.db, c.ctx, (await createCreditNoteDraft(h.db, c.ctx, inv.id)).id, { now: NOW });
    expect(await entryLines(c.ctx, `sales:${credit.id}`)).toEqual([
      { account: "411000", debit: "0.00", credit: "120.00", aux: "C00001", journal: "VE" },
      { account: "707000", debit: "100.00", credit: "0.00", aux: null, journal: "VE" },
      { account: "445711", debit: "20.00", credit: "0.00", aux: null, journal: "VE" },
    ]);
    expect(await accountBalance(c.ctx, "411000")).toBe("0.00");

    // Rejouer la comptabilisation ne crée pas de doublon.
    const { getSalesDocument } = await import("@/server/services/sales");
    const full = await getSalesDocument(h.db, c.ctx, inv.id); // lecture hors transaction (requêtes parallèles)
    await h.db.transaction(async (tx) => {
      await postSalesDocument(tx, await loadCompany(tx, c.company.id), { doc: full.doc, lines: full.lines, party: full.party, sourceNumber: null });
    });
    expect((await listEntries(h.db, c.ctx, { fiscalYear: 2026, page: 1 })).total).toBe(2);
  });
});

describe("achats", () => {
  it("dépense et paiement fournisseur ; franchise en base : TVA non récupérable en charge", async () => {
    const c = await setupCompany("Achats");
    const e = await validateExpense(
      h.db,
      c.ctx,
      (
        await createExpense(h.db, c.ctx, {
          thirdPartyId: c.supplier.id,
          supplierReference: "F-1",
          invoiceDate: "2026-10-10",
          lines: [
            { category: "loyer", description: "Loyer", amountExclTax: "500", vatRate: "20" },
            { category: "immobilisation", description: "Ordinateur", amountExclTax: "800", vatRate: "20" },
          ],
        })
      ).id,
      { now: NOW },
    );
    expect(await entryLines(c.ctx, `expense:${e.id}`)).toEqual([
      { account: "613200", debit: "500.00", credit: "0.00", aux: null, journal: "AC" },
      { account: "218300", debit: "800.00", credit: "0.00", aux: null, journal: "AC" },
      { account: "445620", debit: "160.00", credit: "0.00", aux: null, journal: "AC" },
      { account: "445660", debit: "100.00", credit: "0.00", aux: null, journal: "AC" },
      { account: "401000", debit: "0.00", credit: "1560.00", aux: "F00001", journal: "AC" },
    ]);
    const p = await payExpense(h.db, c.ctx, e.id, { idempotencyKey: randomUUID(), paymentDate: "2026-10-20", method: "transfer", amount: "1560" }, { now: NOW });
    expect(await entryLines(c.ctx, `expense_payment:${p.result.id}`)).toEqual([
      { account: "401000", debit: "1560.00", credit: "0.00", aux: "F00001", journal: "BQ1" },
      { account: "512000", debit: "0.00", credit: "1560.00", aux: null, journal: "BQ1" },
    ]);

    const f = await setupCompany("Franchise", { vatRegime: "franchise_en_base", vatNumber: "" });
    const ef = await validateExpense(
      h.db,
      f.ctx,
      (await createExpense(h.db, f.ctx, { thirdPartyId: f.supplier.id, invoiceDate: "2026-10-10", lines: [{ category: "telecom", description: "Box", amountExclTax: "30", vatRate: "20" }] })).id,
      { now: NOW },
    );
    expect(await entryLines(f.ctx, `expense:${ef.id}`)).toEqual([
      { account: "626000", debit: "36.00", credit: "0.00", aux: null, journal: "AC" },
      { account: "401000", debit: "0.00", credit: "36.00", aux: "F00001", journal: "AC" },
    ]);
  });
});

describe("intégrité, restitutions et FEC", () => {
  let c: Awaited<ReturnType<typeof setupCompany>>;
  beforeAll(async () => {
    c = await setupCompany("Restitutions", { vatOnDebits: true });
    const r20 = c.rates.find((r) => r.rate === "20.00")!.id;
    for (const ht of ["100", "250.50"]) {
      const inv = await issueDocument(
        h.db,
        c.ctx,
        (await createDraft(h.db, c.ctx, "invoice", { thirdPartyId: c.customer.id, lines: [{ description: "Vente\tavec tabulation", kind: "good", quantity: "1", unit: "unité", unitPriceExclTax: ht, vatRateId: r20 }] })).id,
        { now: NOW },
      );
      await recordPayment(
        h.db,
        c.ctx,
        { idempotencyKey: randomUUID(), kind: "receipt", thirdPartyId: c.customer.id, paymentDate: "2026-10-21", method: "card", amount: inv.totalInclTax, allocations: [{ documentId: inv.id, amount: inv.totalInclTax }] },
        { now: NOW },
      );
    }
  });

  it("la base refuse la modification d'une écriture et toute écriture déséquilibrée", async () => {
    const [line] = await h.db.select().from(journalLines).where(eq(journalLines.companyId, c.company.id)).limit(1);
    expect(await dbError(h.db.update(journalLines).set({ debit: "1.00" }).where(eq(journalLines.id, line!.id)))).toMatch(/ajout seul/);
    expect(await dbError(h.db.delete(journalEntries).where(eq(journalEntries.companyId, c.company.id)))).toMatch(/ajout seul/);
    const unbalanced = h.db.transaction(async (tx) => {
      const [e] = await tx
        .insert(journalEntries)
        .values({ companyId: c.company.id, journalCode: "VE", fiscalYear: 2026, entrySeq: 999, entryDate: "2026-10-21", pieceRef: "X", pieceDate: "2026-10-21", label: "Test", sourceKey: "test:desequilibre", validatedAt: new Date() })
        .returning();
      await tx.insert(journalLines).values([
        { companyId: c.company.id, entryId: e!.id, lineNo: 1, accountNumber: "512000", label: "x", debit: "10.00", credit: "0.00" },
        { companyId: c.company.id, entryId: e!.id, lineNo: 2, accountNumber: "411000", label: "x", debit: "0.00", credit: "9.99" },
      ]);
    });
    expect(await dbError(unbalanced)).toMatch(/déséquilibrée/);
  });

  it("balance équilibrée, numérotation continue, grand livre avec solde progressif", async () => {
    const bounds = fiscalYearBounds(await loadCompany(h.db, c.company.id), 2026);
    expect(bounds).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    const tb = await trialBalance(h.db, c.ctx, bounds.from, bounds.to);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(tb.totals.debitBalance).toBe(tb.totals.creditBalance);
    expect(tb.accounts.find((a) => a.account === "411000")).toMatchObject({ debitBalance: "0.00", creditBalance: "0.00" });
    expect(await checkLedger(h.db, c.ctx, 2026)).toMatchObject({ balanced: true, continuous: true, entries: 4 });
    const gl = await generalLedger(h.db, c.ctx, "512000", bounds.from, bounds.to);
    expect(gl.rows.map((r) => r.balance)).toEqual(["120.00", "420.60"]);
    expect(gl.closing).toBe("420.60");
  });

  it("FEC : nom, en-tête, 18 zones, dates AAAAMMJJ, virgule décimale, ordre de numérotation", async () => {
    const fec = await exportFec(h.db, c.ctx, 2026);
    expect(fec.filename).toBe("732829320FEC20261231.txt");
    // Ne pas utiliser trimEnd() : il supprimerait les zones vides de fin de la dernière ligne.
    const rows = fec.content.replace(/\r\n$/, "").split("\r\n").map((l) => l.split("\t"));
    expect(rows[0]).toEqual([
      "JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib", "CompAuxNum", "CompAuxLib", "PieceRef",
      "PieceDate", "EcritureLib", "Debit", "Credit", "EcritureLet", "DateLet", "ValidDate", "Montantdevise", "Idevise",
    ]);
    expect(rows.slice(1).filter((r) => r.length !== 18)).toEqual([]);
    expect(rows[1]).toEqual(expect.arrayContaining(["VE", "Ventes", "1", "20261021", "411000", "Clients", "C00001", "Jeanne Client", "FA-2026-00001", "120,00", "0,00"]));
    expect(rows.slice(1).map((r) => Number(r[2]))).toEqual([...rows.slice(1).map((r) => Number(r[2]))].sort((a, b) => a - b));
    expect(fec.content).not.toMatch(/\d\.\d\d\t/); // aucun point décimal
    expect(rows.slice(1).every((r) => /^\d{8}$/.test(r[15]!))).toBe(true);
  });

  it("isolation et droits : une autre entreprise ne voit rien ; le FEC exige exports.run", async () => {
    const other = await setupCompany("Autre");
    expect((await listEntries(h.db, other.ctx, { fiscalYear: 2026, page: 1 })).total).toBe(0);
    await expect(exportFec(h.db, { ...c.ctx, role: "viewer" }, 2026)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(exportFec(h.db, { ...c.ctx, role: "sales" }, 2026)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("reprise comptable", () => {
  it("comptabilise les événements manquants sans doublon, et peut être relancée", async () => {
    const { backfillAccounting } = await import("@/server/services/accounting-backfill");
    const c = await setupCompany("Reprise", { vatOnDebits: true });
    const r20 = c.rates.find((r) => r.rate === "20.00")!.id;
    const inv = await issueDocument(
      h.db,
      c.ctx,
      (await createDraft(h.db, c.ctx, "invoice", { thirdPartyId: c.customer.id, lines: [{ description: "X", kind: "good", quantity: "1", unit: "unité", unitPriceExclTax: "10", vatRateId: r20 }] })).id,
      { now: NOW },
    );
    const before = (await listEntries(h.db, c.ctx, { fiscalYear: 2026, page: 1 })).total;
    await backfillAccounting(h.db, c.company.id);
    await backfillAccounting(h.db, c.company.id);
    expect((await listEntries(h.db, c.ctx, { fiscalYear: 2026, page: 1 })).total).toBe(before);
    expect((await entryLines(c.ctx, `sales:${inv.id}`)).length).toBe(3);
  });
});
