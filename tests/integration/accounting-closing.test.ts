import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { fiscalYearClosures, journalEntries, journalLines, letterings } from "@/server/db/schema";
import { listVatRates, updateCompany } from "@/server/services/companies";
import { createThirdParty } from "@/server/services/third-parties";
import { createCreditNoteDraft, createDraft, issueDocument } from "@/server/services/sales";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { createExpense, payExpense, validateExpense } from "@/server/services/expenses";
import {
  autoLetter,
  closeFiscalYear,
  fiscalYearClosingPreview,
  letteringCode,
  letteringLinesOf,
  letterLines,
  listFiscalYears,
  postManualEntry,
  unletter,
  vatSummary,
} from "@/server/services/accounting-closing";
import { checkLedger, exportFec } from "@/server/services/accounting-reports";
import { closeSession, closeToday, createRegister, openSession, recordTicket } from "@/server/services/cash";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
const at = (iso: string) => ({ now: new Date(`${iso}T10:00:00Z`) });

async function failure(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} | ${e.cause?.message ?? ""}`;
  }
  throw new Error("L'opération aurait dû être refusée.");
}

async function setupCompany(name: string, overrides: Record<string, unknown> = { vatOnDebits: true }) {
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
  const r20 = rates.find((r) => r.rate === "20.00")!.id;
  const customer = await createThirdParty(h.db, c.ctx, { partyType: "individual", name: "Jeanne Client", billingLine1: "2 rue", billingCity: "Lyon" });
  const supplier = await createThirdParty(h.db, c.ctx, { partyType: "business", name: "Fournisseur SA", isCustomer: false, isSupplier: true });
  const invoice = async (ht: string, day: string, kind: "service" | "good" = "service") => {
    const d = await createDraft(h.db, c.ctx, "invoice", {
      thirdPartyId: customer.id,
      lines: [{ description: "Prestation", kind, quantity: "1", unit: "forfait", unitPriceExclTax: ht, vatRateId: r20 }],
    });
    return issueDocument(h.db, c.ctx, d.id, at(day));
  };
  const pay = async (documentId: string, amount: string, day: string) =>
    (
      await recordPayment(
        h.db,
        c.ctx,
        { idempotencyKey: randomUUID(), kind: "receipt", thirdPartyId: customer.id, paymentDate: day, method: "transfer", amount, allocations: [{ documentId, amount }] },
        at(day),
      )
    ).result;
  const expense = async (ht: string, day: string, category = "loyer") =>
    validateExpense(h.db, c.ctx, (await createExpense(h.db, c.ctx, { thirdPartyId: supplier.id, invoiceDate: day, lines: [{ category, description: "Achat", amountExclTax: ht, vatRate: "20" }] })).id, at(day));
  return { ...c, customer, supplier, invoice, pay, expense };
}

const lettered = async (c: Awaited<ReturnType<typeof setupCompany>>, account = "411000", aux = c.customer.code) =>
  (await letteringLinesOf(h.db, c.ctx, account, aux)).map((l) => [l.pieceRef, l.debit, l.credit, l.code]);

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("lettrage", () => {
  it("codes A…Z, AA…", () => {
    expect([1, 2, 26, 27, 28, 52, 53, 702, 703].map(letteringCode)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("automatique : facture soldée par ses règlements, avoir sur facture, dépense payée ; FEC renseigné", async () => {
    const c = await setupCompany("LettrageAuto");
    const inv1 = await c.invoice("100", "2026-03-10");
    await c.pay(inv1.id, "50", "2026-03-20");
    expect(await autoLetter(h.db, c.ctx, at("2026-03-21"))).toEqual({ created: 0 }); // 70 restent dus
    await c.pay(inv1.id, "70", "2026-04-02");
    const inv2 = await c.invoice("50", "2026-04-05");
    await issueDocument(h.db, c.ctx, (await createCreditNoteDraft(h.db, c.ctx, inv2.id)).id, at("2026-04-06"));
    const exp = await c.expense("30", "2026-04-07");
    await payExpense(h.db, c.ctx, exp.id, { idempotencyKey: randomUUID(), paymentDate: "2026-04-08", method: "transfer", amount: "36" }, at("2026-04-08"));
    const inv3 = await c.invoice("10", "2026-04-09"); // non réglée : reste ouverte

    expect(await autoLetter(h.db, c.ctx, at("2026-04-10"))).toEqual({ created: 3 });
    const rows = await lettered(c);
    expect(rows.filter((r) => r[3] === "A").map((r) => r[0])).toEqual([inv1.number, expect.stringMatching(/^RG/), expect.stringMatching(/^RG/)]);
    expect(rows.filter((r) => r[3] === "B").map((r) => [r[1], r[2]])).toEqual([["60.00", "0.00"], ["0.00", "60.00"]]);
    expect(rows.find((r) => r[0] === inv3.number)![3]).toBeNull();
    expect((await lettered(c, "401000", c.supplier.code)).map((r) => r[3])).toEqual(["A", "A"]); // codes par compte
    expect(await autoLetter(h.db, c.ctx, at("2026-04-11"))).toEqual({ created: 0 }); // idempotent

    const fec = (await exportFec(h.db, c.ctx, 2026)).content.split("\r\n").map((l) => l.split("\t"));
    const clientLines = fec.filter((f) => f[4] === "411000");
    expect(clientLines.filter((f) => f[13] === "A")).toHaveLength(3);
    expect(clientLines.filter((f) => f[13] === "A").every((f) => f[14] === "20260410")).toBe(true);
    expect(clientLines.filter((f) => f[13] === "")).toHaveLength(1); // facture 3
  });

  it("automatique : une contre-passation se lettre avec le règlement annulé, la facture reste ouverte", async () => {
    const c = await setupCompany("LettrageContre");
    const inv = await c.invoice("100", "2026-03-10");
    const p = await c.pay(inv.id, "50", "2026-03-11");
    await reversePayment(h.db, c.ctx, p.id, { idempotencyKey: randomUUID(), reason: "Chèque impayé" }, at("2026-03-12"));
    expect(await autoLetter(h.db, c.ctx, at("2026-03-13"))).toEqual({ created: 1 });
    expect(await lettered(c)).toEqual([
      [inv.number, "120.00", "0.00", null],
      [p.number, "0.00", "50.00", "A"],
      [expect.stringMatching(/^RG/), "50.00", "0.00", "A"],
    ]);
  });

  it("manuel : contrôles, délettrage tracé, codes jamais réutilisés ; protections en base", async () => {
    const c = await setupCompany("LettrageManuel");
    const inv = await c.invoice("100", "2026-05-02");
    await c.pay(inv.id, "120", "2026-05-03");
    await c.invoice("10", "2026-05-04");
    const lines = await letteringLinesOf(h.db, c.ctx, "411000", c.customer.code);
    const [invLine, payLine, otherLine] = lines;

    expect(await failure(letterLines(h.db, c.ctx, [invLine!.id]))).toContain("au moins deux");
    expect(await failure(letterLines(h.db, c.ctx, [invLine!.id, otherLine!.id]))).toContain("doit être nul");
    const [revenue] = await h.db
      .select({ id: journalLines.id })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(eq(journalEntries.sourceKey, `sales:${inv.id}`), eq(journalLines.accountNumber, "706000")));
    expect(await failure(letterLines(h.db, c.ctx, [invLine!.id, revenue!.id]))).toContain("non lettrable");

    const group = await letterLines(h.db, c.ctx, [invLine!.id, payLine!.id], at("2026-05-05"));
    expect(group).toMatchObject({ code: "A", method: "manual", accountNumber: "411000", auxNumber: c.customer.code });
    expect(await failure(letterLines(h.db, c.ctx, [invLine!.id, payLine!.id]))).toContain("déjà lettrées");

    // Base : un groupe ne se modifie pas, une ligne d'un lettrage actif ne se retire pas.
    expect(await failure(h.db.update(letterings).set({ code: "Z" }).where(eq(letterings.id, group.id)))).toContain("seul le délettrage");
    expect(await failure(h.db.execute(sql`delete from lettering_lines where lettering_id = ${group.id}`))).toContain("délettrer avant");
    expect(await failure(h.db.delete(letterings).where(eq(letterings.id, group.id)))).toContain("suppression interdite");

    await unletter(h.db, c.ctx, group.id, at("2026-05-06"));
    expect((await letteringLinesOf(h.db, c.ctx, "411000", c.customer.code)).every((l) => l.code === null)).toBe(true);
    expect(await failure(unletter(h.db, c.ctx, group.id))).toContain("introuvable");
    expect((await letterLines(h.db, c.ctx, [invLine!.id, payLine!.id])).code).toBe("B");

    // Groupe déséquilibré inséré directement : refusé en fin de transaction.
    expect(
      await failure(
        h.db.transaction(async (tx) => {
          const [g] = await tx
            .insert(letterings)
            .values({ companyId: c.ctx.companyId, accountNumber: "411000", auxNumber: c.customer.code, code: "ZZ", method: "manual", letteredAt: new Date(), letteredBy: c.ctx.userId })
            .returning();
          await tx.execute(sql`insert into lettering_lines (company_id, lettering_id, line_id) values (${c.ctx.companyId}, ${g!.id}, ${otherLine!.id})`);
        }),
      ),
    ).toContain("déséquilibré");
  });
});

describe("clôture d'exercice", () => {
  it("contrôles, résultat, à-nouveaux, exercice verrouillé, lettrage avec l'à-nouveau", async () => {
    const c = await setupCompany("Cloture");
    const inv1 = await c.invoice("100", "2025-06-10");
    await c.pay(inv1.id, "120", "2025-06-20");
    const exp = await c.expense("50", "2025-09-01");
    const inv2 = await c.invoice("200", "2025-11-05");
    await c.pay(inv2.id, "240", "2026-01-05"); // réglée sur l'exercice suivant

    const early = await fiscalYearClosingPreview(h.db, c.ctx, 2025, at("2025-12-15"));
    expect(early).toMatchObject({ canClose: false, result: "250.00" });
    expect(early.checks.find((x) => x.label === "Exercice terminé")!.ok).toBe(false);
    expect(await failure(closeFiscalYear(h.db, c.ctx, 2025, at("2025-12-15")))).toContain("se termine le 31/12/2025");

    const preview = await fiscalYearClosingPreview(h.db, c.ctx, 2025, at("2026-01-10"));
    expect(preview.checks.every((x) => x.ok)).toBe(true);
    const closure = await closeFiscalYear(h.db, c.ctx, 2025, at("2026-01-10"));
    expect(closure).toMatchObject({ fiscalYear: 2025, periodStart: "2025-01-01", periodEnd: "2025-12-31", result: "250.00" });

    const an = await h.db
      .select({ account: journalLines.accountNumber, aux: journalLines.auxNumber, debit: journalLines.debit, credit: journalLines.credit, date: journalEntries.entryDate, year: journalEntries.fiscalYear })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(eq(journalEntries.sourceKey, `opening:2025`))
      .orderBy(journalLines.lineNo);
    expect(an.every((l) => l.date === "2026-01-01" && l.year === 2026)).toBe(true);
    expect(an.map((l) => [l.account, l.aux, l.debit, l.credit])).toEqual([
      ["401000", c.supplier.code, "0.00", "60.00"],
      ["411000", c.customer.code, "240.00", "0.00"],
      ["445660", null, "10.00", "0.00"],
      ["445711", null, "0.00", "60.00"],
      ["512000", null, "120.00", "0.00"],
      ["120000", null, "0.00", "250.00"],
    ]);

    // Exercice verrouillé : par le service et par la base.
    expect(await failure(payExpense(h.db, c.ctx, exp.id, { idempotencyKey: randomUUID(), paymentDate: "2025-12-31", method: "transfer", amount: "60" }, at("2026-01-11")))).toContain("exercice 2025 est clôturé");
    expect(
      await failure(
        h.db.insert(journalEntries).values({ companyId: c.ctx.companyId, journalCode: "OD", fiscalYear: 2025, entrySeq: 999, entryDate: "2025-12-31", pieceRef: "X", pieceDate: "2025-12-31", label: "X", sourceKey: "x", validatedAt: new Date() }),
      ),
    ).toContain("clôturé");
    expect(await failure(h.db.update(fiscalYearClosures).set({ result: "0" }).where(eq(fiscalYearClosures.id, closure.id)))).toContain("ajout seul");
    expect(await failure(closeFiscalYear(h.db, c.ctx, 2025, at("2026-01-11")))).toContain("déjà clôturé");

    // Exercice 2026 : l'à-nouveau client est lettré avec le règlement de janvier.
    expect(await autoLetter(h.db, c.ctx, at("2026-01-12"))).toEqual({ created: 2 }); // 2025 : facture 1 ↔ règlement ; 2026 : AN ↔ règlement
    const rows = await letteringLinesOf(h.db, c.ctx, "411000", c.customer.code);
    expect(rows.filter((r) => r.fiscalYear === 2026).map((r) => [r.journalCode, r.code])).toEqual([["AN", "B"], ["BQ1", "B"]]);
    expect(rows.find((r) => r.pieceRef === inv2.number)!.code).toBeNull(); // solde repris par l'à-nouveau

    expect(await checkLedger(h.db, c.ctx, 2026)).toMatchObject({ balanced: true, continuous: true });
    const fec = (await exportFec(h.db, c.ctx, 2026)).content.split("\r\n");
    expect(fec[1]!.split("\t")[0]).toBe("AN"); // à-nouveaux en tête
    const years = await listFiscalYears(h.db, c.ctx, at("2026-01-12"));
    expect(years.map((y) => [y.year, y.closure ? "clos" : "ouvert"])).toEqual([[2026, "ouvert"], [2025, "clos"]]);
  });

  it("perte, exercices antérieurs non clos, journées de caisse ouvertes", async () => {
    const c = await setupCompany("Perte");
    await c.invoice("10", "2024-05-02");
    await c.expense("100", "2025-03-01");
    const p = await fiscalYearClosingPreview(h.db, c.ctx, 2025, at("2026-02-01"));
    expect(p.result).toBe("-100.00");
    expect(p.checks.find((x) => x.label === "Exercices antérieurs clôturés")).toMatchObject({ ok: false, detail: "Clôturez d'abord l'exercice 2024." });

    await closeFiscalYear(h.db, c.ctx, 2024, at("2026-02-01"));

    // Une journée de caisse de l'exercice non clôturée bloque la clôture.
    const register = await createRegister(h.db, c.ctx, { code: "C1", name: "Comptoir" });
    await openSession(h.db, c.ctx, register.id, { openingFloat: "0" }, at("2025-03-02"));
    await recordTicket(h.db, c.ctx, register.id, { idempotencyKey: randomUUID(), lines: [{ label: "Article", kind: "good", quantity: "1", unitPriceInclTax: "12", vatRate: "20" }], payments: [{ method: "cash", amount: "12" }] }, at("2025-03-02"));
    const blocked = await fiscalYearClosingPreview(h.db, c.ctx, 2025, at("2026-02-01"));
    expect(blocked.checks.find((x) => x.label === "Journées de caisse clôturées")).toMatchObject({ ok: false, detail: "Journée du 02/03/2025 non clôturée." });
    await closeSession(h.db, c.ctx, register.id, { countedCash: "12" }, at("2025-03-02"));
    await closeToday(h.db, c.ctx, register.id, at("2026-02-01"));
    await closeFiscalYear(h.db, c.ctx, 2025, at("2026-02-01"));
    const [line] = await h.db
      .select({ debit: journalLines.debit })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(eq(journalEntries.sourceKey, "opening:2025"), eq(journalLines.accountNumber, "129000")));
    expect(line!.debit).toBe("90.00"); // perte 100 − 10 HT de ventes en caisse
  });
});

describe("saisie d'opérations diverses", () => {
  it("écriture équilibrée, comptes et tiers contrôlés, idempotente, refusée sur un exercice clos", async () => {
    const c = await setupCompany("SaisieOD");
    const entry = (lines: Record<string, string>[], extra: Record<string, unknown> = {}) => ({
      idempotencyKey: randomUUID(),
      entryDate: "2026-06-30",
      pieceRef: "INV-1",
      label: "Dotation aux amortissements",
      lines,
      ...extra,
    });
    expect(await failure(postManualEntry(h.db, c.ctx, entry([{ account: "681100", debit: "100" }, { account: "281830", accountLabel: "Amortissements matériel", credit: "90" }]), at("2026-07-01")))).toContain("déséquilibrée");
    expect(await failure(postManualEntry(h.db, c.ctx, entry([{ account: "681100", debit: "100", credit: "100" }, { account: "281830", credit: "100" }]), at("2026-07-01")))).toContain("soit un débit, soit un crédit");
    expect(await failure(postManualEntry(h.db, c.ctx, entry([{ account: "681100", debit: "100" }, { account: "281830", credit: "100" }]), at("2026-07-01")))).toContain("absent du plan");
    expect(await failure(postManualEntry(h.db, c.ctx, entry([{ account: "411000", auxNumber: "X999", debit: "1" }, { account: "758000", credit: "1" }]), at("2026-07-01")))).toContain("auxiliaire inconnu");
    expect(await failure(postManualEntry(h.db, c.ctx, entry([{ account: "681100", debit: "1" }, { account: "758000", credit: "1" }], { entryDate: "2026-07-02" }), at("2026-07-01")))).toContain("postérieure");

    const input = entry([
      { account: "681100", accountLabel: "Dotations aux amortissements", debit: "100,50" },
      { account: "281830", accountLabel: "Amortissements du matériel informatique", credit: "100,50" },
    ]);
    const first = await postManualEntry(h.db, c.ctx, input, at("2026-07-01"));
    expect(await postManualEntry(h.db, c.ctx, input, at("2026-07-01"))).toEqual({ id: first.id, replayed: true });
    const lines = await h.db.select({ account: journalLines.accountNumber, debit: journalLines.debit, credit: journalLines.credit, journal: journalEntries.journalCode }).from(journalLines).innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId)).where(eq(journalEntries.id, first.id)).orderBy(journalLines.lineNo);
    expect(lines).toEqual([
      { account: "681100", debit: "100.50", credit: "0.00", journal: "OD" },
      { account: "281830", debit: "0.00", credit: "100.50", journal: "OD" },
    ]);
    const withAux = await postManualEntry(h.db, c.ctx, entry([{ account: "411000", auxNumber: c.customer.code, debit: "5" }, { account: "758000", credit: "5" }]), at("2026-07-01"));
    expect(withAux.replayed).toBe(false);

    await c.invoice("10", "2025-03-03");
    await closeFiscalYear(h.db, c.ctx, 2025, at("2026-07-01"));
    expect(await failure(postManualEntry(h.db, c.ctx, entry([{ account: "681100", debit: "1" }, { account: "281830", credit: "1" }], { entryDate: "2025-12-31" }), at("2026-07-01")))).toContain("2025 est clôturé");
  });
});

describe("aide à la déclaration de TVA", () => {
  it("TVA sur encaissements : exigible au règlement ; déductible biens / immobilisations", async () => {
    const c = await setupCompany("TVA", { vatOnDebits: false });
    const inv = await c.invoice("100", "2026-03-05");
    await c.expense("50", "2026-03-15");
    await c.expense("1000", "2026-03-16", "immobilisation");
    await c.pay(inv.id, "60", "2026-04-10");

    expect(await vatSummary(h.db, c.ctx, "2026-03-01", "2026-03-31")).toMatchObject({
      collected: [],
      totalCollected: "0.00",
      deductibleGoods: "10.00",
      deductibleAssets: "200.00",
      totalDeductible: "210.00",
      balance: "-210.00",
      pendingAtEnd: "20.00",
    });
    expect(await vatSummary(h.db, c.ctx, "2026-04-01", "2026-04-30")).toMatchObject({
      collected: [{ rate: "20.00", account: "445711", vat: "10.00", base: "50.00" }],
      totalDeductible: "0.00",
      balance: "10.00",
      pendingAtEnd: "10.00",
    });
    expect(await failure(vatSummary(h.db, c.ctx, "2026-05-01", "2026-04-01"))).toContain("Période invalide");
  });
});
