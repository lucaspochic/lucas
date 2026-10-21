import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { journalEntries, journalLines } from "@/server/db/schema";
import { listVatRates, updateCompany } from "@/server/services/companies";
import { createThirdParty } from "@/server/services/third-parties";
import {
  convertQuoteToInvoice,
  createCreditNoteDraft,
  createDepositDraft,
  createDraft,
  getSalesDocument,
  issueDocument,
  verifyDocumentIntegrity,
} from "@/server/services/sales";
import { recordPayment } from "@/server/services/payments";
import type { CompanyContext } from "@/server/security/permissions";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
const NOW = { now: new Date("2026-10-21T10:00:00Z") };

async function failure(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("L'opération aurait dû être refusée.");
}

async function balance(ctx: CompanyContext, account: string) {
  const [r] = await h.db
    .select({ b: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::text` })
    .from(journalLines)
    .where(and(eq(journalLines.companyId, ctx.companyId), eq(journalLines.accountNumber, account)));
  return Number(r!.b).toFixed(2);
}

async function entry(ctx: CompanyContext, docId: string) {
  const rows = await h.db
    .select({ account: journalLines.accountNumber, debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceKey, `sales:${docId}`)))
    .orderBy(journalLines.lineNo);
  return rows.map((r) => [r.account, r.debit, r.credit]);
}

async function setup(name: string) {
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
  });
  const r20 = (await listVatRates(h.db, c.ctx)).find((r) => r.rate === "20.00")!.id;
  const customer = await createThirdParty(h.db, c.ctx, { partyType: "individual", name: "Jeanne Client", billingLine1: "2 rue", billingCity: "Lyon" });
  // Devis : prestation 1 000 HT + fournitures 500 HT, remise globale 10 % → bases 900 / 450, TTC 1 620.
  const quote = await issueDocument(
    h.db,
    c.ctx,
    (
      await createDraft(h.db, c.ctx, "quote", {
        thirdPartyId: customer.id,
        globalDiscountPercent: "10",
        lines: [
          { description: "Pose", kind: "service", quantity: "1", unit: "forfait", unitPriceExclTax: "1000", vatRateId: r20 },
          { description: "Fournitures", kind: "good", quantity: "1", unit: "lot", unitPriceExclTax: "500", vatRateId: r20 },
        ],
      })
    ).id,
    NOW,
  );
  expect(quote.totalInclTax).toBe("1620.00");
  return { ...c, customer, quote };
}

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("factures d'acompte et facture de solde", () => {
  it("acomptes : 419100, TVA des prestations à l'encaissement, TVA des biens en attente de livraison ; solde net des acomptes", async () => {
    const c = await setup("Acomptes");
    const d1 = await issueDocument(h.db, c.ctx, (await createDepositDraft(h.db, c.ctx, c.quote.id, { percent: "30" })).id, NOW);
    expect(d1).toMatchObject({ type: "invoice", isDeposit: true, number: "FA-2026-00001", totalExclTax: "405.00", totalVat: "81.00", totalInclTax: "486.00" });
    expect(await entry(c.ctx, d1.id)).toEqual([
      ["411000", "486.00", "0.00"],
      ["419100", "0.00", "405.00"],
      ["445741", "0.00", "54.00"], // prestations : exigible à l'encaissement
      ["445800", "0.00", "27.00"], // biens : en attente de livraison
    ]);
    // Encaissement de l'acompte : la TVA des prestations devient exigible, pas celle des biens.
    await recordPayment(
      h.db,
      c.ctx,
      { idempotencyKey: randomUUID(), kind: "receipt", thirdPartyId: c.customer.id, paymentDate: "2026-10-21", method: "transfer", amount: "486", allocations: [{ documentId: d1.id, amount: "486" }] },
      NOW,
    );
    expect(await balance(c.ctx, "445741")).toBe("0.00");
    expect(await balance(c.ctx, "445711")).toBe("-54.00");
    expect(await balance(c.ctx, "445800")).toBe("-27.00");

    // Dépassement du devis refusé.
    const tooMuch = await createDepositDraft(h.db, c.ctx, c.quote.id, { percent: "80" });
    expect(await failure(issueDocument(h.db, c.ctx, tooMuch.id, NOW))).toContain("dépasseraient le montant du devis");

    // Facture de solde préparée, puis un second acompte émis avant elle : repris à l'émission.
    const final = await convertQuoteToInvoice(h.db, c.ctx, c.quote.id);
    expect(final.created).toBe(true);
    const d2 = await issueDocument(h.db, c.ctx, (await createDepositDraft(h.db, c.ctx, c.quote.id, { percent: "10" })).id, NOW);
    expect(d2.totalInclTax).toBe("162.00");
    const issued = await issueDocument(h.db, c.ctx, final.id, NOW);
    expect(issued).toMatchObject({ isDeposit: false, totalExclTax: "810.00", totalVat: "162.00", totalInclTax: "972.00" }); // 1 620 − 486 − 162
    const { lines } = await getSalesDocument(h.db, c.ctx, final.id);
    expect(lines.filter((l) => l.deductedDocumentId).map((l) => [l.quantity, l.unitPriceExclTax, l.kind, l.totalExclTax])).toEqual([
      ["-1.000", "270.0000", "service", "-270.00"],
      ["-1.000", "135.0000", "good", "-135.00"],
      ["-1.000", "90.0000", "service", "-90.00"],
      ["-1.000", "45.0000", "good", "-45.00"],
    ]);
    expect(await entry(c.ctx, final.id)).toEqual([
      ["411000", "972.00", "0.00"],
      ["706000", "0.00", "900.00"],
      ["707000", "0.00", "450.00"],
      ["419100", "540.00", "0.00"],
      ["445711", "0.00", "90.00"], // biens livrés : 450 × 20 %
      ["445741", "0.00", "108.00"], // prestations restant à encaisser : (900 − 360) × 20 %
      ["445800", "36.00", "0.00"], // reprise de la TVA des acomptes sur biens
    ]);
    // Tout est soldé : comptes d'acompte et d'attente de livraison à zéro.
    expect(await balance(c.ctx, "419100")).toBe("0.00");
    expect(await balance(c.ctx, "445800")).toBe("0.00");
    expect(await verifyDocumentIntegrity(h.db, c.ctx, final.id)).toMatchObject({ valid: true });
    expect(await verifyDocumentIntegrity(h.db, c.ctx, d1.id)).toMatchObject({ valid: true });

    // Plus d'acompte possible après la facture de solde.
    const late = await createDepositDraft(h.db, c.ctx, c.quote.id, { percent: "5" });
    expect(await failure(issueDocument(h.db, c.ctx, late.id, NOW))).toContain("déjà soldé");
  });

  it("avoir sur facture d'acompte : écritures inverses ; l'acompte annulé n'est plus déduit", async () => {
    const c = await setup("AcompteAvoir");
    const d = await issueDocument(h.db, c.ctx, (await createDepositDraft(h.db, c.ctx, c.quote.id, { percent: "50" })).id, NOW);
    const credit = await issueDocument(h.db, c.ctx, (await createCreditNoteDraft(h.db, c.ctx, d.id)).id, NOW);
    expect(credit).toMatchObject({ type: "credit_note", isDeposit: true, totalInclTax: "810.00" });
    expect(await balance(c.ctx, "419100")).toBe("0.00");
    expect(await balance(c.ctx, "445800")).toBe("0.00");
    const final = await issueDocument(h.db, c.ctx, (await convertQuoteToInvoice(h.db, c.ctx, c.quote.id)).id, NOW);
    expect(final.totalInclTax).toBe("1620.00");
    expect(await failure(createDepositDraft(h.db, c.ctx, final.id, { percent: "10" }))).toContain("devis émis ou accepté");
    expect(await failure(createDepositDraft(h.db, c.ctx, c.quote.id, { percent: "0" }))).toMatch(/supérieur à zéro|Pourcentage/);
  });
});
