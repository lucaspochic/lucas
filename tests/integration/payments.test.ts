import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { paymentAllocations, payments } from "@/server/db/schema";
import { listVatRates, updateCompany } from "@/server/services/companies";
import { createThirdParty } from "@/server/services/third-parties";
import { createCreditNoteDraft, createDraft, getSalesDocument, issueDocument, updateDraft } from "@/server/services/sales";
import {
  getPayment,
  invoiceBalances,
  listPayments,
  paymentsForInvoice,
  recordPayment,
  reversePayment,
  verifyPaymentChain,
} from "@/server/services/payments";
import { verifyAuditChain } from "@/server/services/audit";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
let a: Awaited<ReturnType<typeof createUserWithCompany>>;
let b: Awaited<ReturnType<typeof createUserWithCompany>>;
let customerId: string;
let otherCustomerId: string;
let rate20: string;

const NOW = new Date("2026-10-21T09:00:00Z");

async function dbError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} | ${e.cause?.message ?? ""}`;
  }
  throw new Error("La requête aurait dû être refusée.");
}

/** Facture émise de `ht` € HT à 20 %. */
async function issuedInvoice(ht: string, thirdPartyId = customerId) {
  const d = await createDraft(h.db, a.ctx, "invoice", {
    thirdPartyId,
    lines: [{ description: "Prestation", kind: "service", quantity: "1", unit: "forfait", unitPriceExclTax: ht, vatRateId: rate20 }],
  });
  return issueDocument(h.db, a.ctx, d.id, { now: NOW });
}

const pay = (overrides: Record<string, unknown>) => ({
  idempotencyKey: randomUUID(),
  kind: "receipt",
  thirdPartyId: customerId,
  paymentDate: "2026-10-21",
  method: "transfer",
  amount: "0",
  allocations: [],
  ...overrides,
});

beforeAll(async () => {
  h = await createTestDb();
  a = await createUserWithCompany(h, "Reglements");
  b = await createUserWithCompany(h, "Autre");
  await updateCompany(h.db, a.ctx, {
    legalName: "Atelier Règlements SAS",
    legalForm: "SAS",
    shareCapital: "1000.00",
    siren: "732829320",
    vatNumber: "FR44732829320",
    addressLine1: "1 rue Neuve",
    postalCode: "69001",
    city: "Lyon",
    paymentTermsDays: 30,
    latePenaltyText: "Pénalités : taux BCE + 10 points ; indemnité de 40 €.",
    invoicePrefix: "FA",
    creditNotePrefix: "AV",
    quotePrefix: "DE",
  });
  rate20 = (await listVatRates(h.db, a.ctx)).find((r) => r.rate === "20.00")!.id;
  const addr = { billingLine1: "2 rue Vieille", billingPostalCode: "69002", billingCity: "Lyon" };
  customerId = (await createThirdParty(h.db, a.ctx, { partyType: "individual", name: "Jeanne Client", ...addr })).id;
  otherCustomerId = (await createThirdParty(h.db, a.ctx, { partyType: "individual", name: "Paul Autre", ...addr })).id;
});
afterAll(async () => {
  await h.close();
});

describe("encaissements", () => {
  it("paiement partiel puis solde ; statuts dérivés", async () => {
    const inv = await issuedInvoice("100"); // 120 TTC
    const r1 = await recordPayment(h.db, a.ctx, pay({ amount: "50", allocations: [{ documentId: inv.id, amount: "50" }] }), { now: NOW });
    expect(r1.result).toMatchObject({ number: "RG-2026-00001", kind: "receipt", amount: "50.00", partyTypeSnapshot: "individual" });
    let [bal] = await invoiceBalances(h.db, a.ctx, { ids: [inv.id] }, NOW);
    expect(bal).toMatchObject({ paid: "50.00", remaining: "70.00", status: "partial" });
    await recordPayment(h.db, a.ctx, pay({ amount: "70", method: "card", allocations: [{ documentId: inv.id, amount: "70" }] }), { now: NOW });
    [bal] = await invoiceBalances(h.db, a.ctx, { ids: [inv.id] }, NOW);
    expect(bal).toMatchObject({ paid: "120.00", remaining: "0.00", status: "paid" });
    expect((await paymentsForInvoice(h.db, a.ctx, inv.id)).map((p) => p.amount)).toEqual(["50.00", "70.00"]);
  });

  it("une facture échue non réglée est « en retard »", async () => {
    const inv = await issuedInvoice("10");
    const [bal] = await invoiceBalances(h.db, a.ctx, { ids: [inv.id] }, new Date("2026-12-31T12:00:00Z"));
    expect(bal!.status).toBe("overdue");
  });

  it("refuse une imputation supérieure au reste à payer, une facture d'un autre client, une date future", async () => {
    const inv = await issuedInvoice("100");
    await expect(
      recordPayment(h.db, a.ctx, pay({ amount: "200", allocations: [{ documentId: inv.id, amount: "120.01" }] }), { now: NOW }),
    ).rejects.toThrow(/dépasse le reste à payer/);
    await expect(
      recordPayment(h.db, a.ctx, pay({ thirdPartyId: otherCustomerId, amount: "10", allocations: [{ documentId: inv.id, amount: "10" }] }), { now: NOW }),
    ).rejects.toThrow(/autre client/);
    await expect(recordPayment(h.db, a.ctx, pay({ amount: "10", paymentDate: "2026-10-22" }), { now: NOW })).rejects.toThrow(/futur/);
    await expect(
      recordPayment(h.db, a.ctx, pay({ amount: "10", allocations: [{ documentId: inv.id, amount: "20" }] }), { now: NOW }),
    ).rejects.toThrow(/dépasse le montant du règlement/);
  });

  it("le reste à payer tient compte des avoirs", async () => {
    const inv = await issuedInvoice("100");
    const credit = await createCreditNoteDraft(h.db, a.ctx, inv.id);
    await updateDraft(h.db, a.ctx, credit.id, {
      thirdPartyId: customerId,
      lines: [{ description: "Geste commercial", kind: "service", quantity: "1", unit: "forfait", unitPriceExclTax: "25", vatRateId: rate20 }],
    });
    await issueDocument(h.db, a.ctx, credit.id, { now: NOW });
    const [bal] = await invoiceBalances(h.db, a.ctx, { ids: [inv.id] }, NOW);
    expect(bal).toMatchObject({ credited: "30.00", netDue: "90.00", remaining: "90.00" });
  });

  it("un règlement non imputé est accepté (acompte client)", async () => {
    const r = await recordPayment(h.db, a.ctx, pay({ amount: "15", method: "cash" }), { now: NOW });
    expect((await getPayment(h.db, a.ctx, r.result.id)).allocations).toEqual([]);
  });
});

describe("idempotence (anti-rejeu)", () => {
  it("le même envoi deux fois ne crée qu'un règlement", async () => {
    const inv = await issuedInvoice("50");
    const input = pay({ amount: "60", allocations: [{ documentId: inv.id, amount: "60" }] });
    const first = await recordPayment(h.db, a.ctx, input, { now: NOW });
    const second = await recordPayment(h.db, a.ctx, input, { now: NOW });
    expect(second).toMatchObject({ replayed: true, result: { id: first.result.id } });
    expect((await paymentsForInvoice(h.db, a.ctx, inv.id)).length).toBe(1);
    const [bal] = await invoiceBalances(h.db, a.ctx, { ids: [inv.id] }, NOW);
    expect(bal!.paid).toBe("60.00");
  });

  it("des envois simultanés identiques ne créent qu'un règlement", async () => {
    const inv = await issuedInvoice("50");
    const input = pay({ amount: "60", allocations: [{ documentId: inv.id, amount: "60" }] });
    const results = await Promise.all(Array.from({ length: 5 }, () => recordPayment(h.db, a.ctx, input, { now: NOW })));
    expect(new Set(results.map((r) => r.result.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await paymentsForInvoice(h.db, a.ctx, inv.id)).length).toBe(1);
  });

  it("la même clé réutilisée pour une autre demande est refusée", async () => {
    const key = randomUUID();
    await recordPayment(h.db, a.ctx, pay({ idempotencyKey: key, amount: "5" }), { now: NOW });
    await expect(recordPayment(h.db, a.ctx, pay({ idempotencyKey: key, amount: "6" }), { now: NOW })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("des règlements concurrents différents ne dépassent jamais le reste à payer", async () => {
    const inv = await issuedInvoice("100"); // 120 TTC
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        recordPayment(h.db, a.ctx, pay({ amount: "50", allocations: [{ documentId: inv.id, amount: "50" }] }), { now: NOW }),
      ),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const [bal] = await invoiceBalances(h.db, a.ctx, { ids: [inv.id] }, NOW);
    expect(bal).toMatchObject({ paid: "100.00", remaining: "20.00" });
  });
});

describe("remboursement et contre-passation", () => {
  it("rembourse un trop-perçu après avoir, dans la limite du trop-perçu", async () => {
    const inv = await issuedInvoice("100");
    await recordPayment(h.db, a.ctx, pay({ amount: "120", allocations: [{ documentId: inv.id, amount: "120" }] }), { now: NOW });
    const credit = await createCreditNoteDraft(h.db, a.ctx, inv.id);
    await issueDocument(h.db, a.ctx, credit.id, { now: NOW });
    let [bal] = await invoiceBalances(h.db, a.ctx, { ids: [inv.id] }, NOW);
    expect(bal).toMatchObject({ remaining: "-120.00", status: "overpaid" });
    await expect(
      recordPayment(h.db, a.ctx, pay({ kind: "refund", amount: "130", allocations: [{ documentId: inv.id, amount: "130" }] }), { now: NOW }),
    ).rejects.toThrow(/trop-perçu/);
    const refund = await recordPayment(
      h.db,
      a.ctx,
      pay({ kind: "refund", amount: "120", allocations: [{ documentId: inv.id, amount: "120" }] }),
      { now: NOW },
    );
    expect(refund.result.amount).toBe("-120.00");
    [bal] = await invoiceBalances(h.db, a.ctx, { ids: [inv.id] }, NOW);
    expect(bal).toMatchObject({ paid: "0.00", remaining: "0.00", status: "paid" });
  });

  it("contre-passe un règlement erroné sans l'effacer, une seule fois", async () => {
    const inv = await issuedInvoice("100");
    const wrong = await recordPayment(h.db, a.ctx, pay({ amount: "120", allocations: [{ documentId: inv.id, amount: "120" }] }), { now: NOW });
    await expect(reversePayment(h.db, a.ctx, wrong.result.id, { idempotencyKey: randomUUID(), reason: "x" })).rejects.toThrow();
    const rev = await reversePayment(h.db, a.ctx, wrong.result.id, { idempotencyKey: randomUUID(), reason: "Saisie sur le mauvais client" }, { now: NOW });
    expect(rev.result).toMatchObject({ kind: "reversal", amount: "-120.00", reversesPaymentId: wrong.result.id, reference: wrong.result.number });
    const [bal] = await invoiceBalances(h.db, a.ctx, { ids: [inv.id] }, NOW);
    expect(bal).toMatchObject({ paid: "0.00", status: "unpaid" });
    const detail = await getPayment(h.db, a.ctx, wrong.result.id);
    expect(detail.reversedBy?.id).toBe(rev.result.id);
    await expect(reversePayment(h.db, a.ctx, wrong.result.id, { idempotencyKey: randomUUID(), reason: "Encore une fois" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(reversePayment(h.db, a.ctx, rev.result.id, { idempotencyKey: randomUUID(), reason: "Annuler l'annulation" })).rejects.toThrow(
      /ne se contre-passe pas/,
    );
  });
});

describe("inaltérabilité et chaînage", () => {
  it("la base refuse la modification et la suppression des règlements et imputations", async () => {
    const [p] = await h.db.select().from(payments).where(eq(payments.companyId, a.company.id)).limit(1);
    expect(await dbError(h.db.update(payments).set({ amount: "1.00" }).where(eq(payments.id, p!.id)))).toMatch(/ajout seul/);
    expect(await dbError(h.db.delete(payments).where(eq(payments.id, p!.id)))).toMatch(/ajout seul/);
    expect(await dbError(h.db.update(paymentAllocations).set({ amount: "1.00" }).where(eq(paymentAllocations.paymentId, p!.id)))).toMatch(
      /ajout seul/,
    );
  });

  it("la base refuse une imputation sur un brouillon", async () => {
    const draft = await createDraft(h.db, a.ctx, "invoice", {
      thirdPartyId: customerId,
      lines: [{ description: "X", kind: "service", quantity: "1", unit: "forfait", unitPriceExclTax: "1", vatRateId: rate20 }],
    });
    const [p] = await h.db.select().from(payments).where(eq(payments.companyId, a.company.id)).limit(1);
    expect(
      await dbError(h.db.insert(paymentAllocations).values({ companyId: a.company.id, paymentId: p!.id, documentId: draft.id, amount: "1.00" })),
    ).toMatch(/facture émise/);
  });

  it("la chaîne est intègre et détecte une altération contournant les triggers", async () => {
    expect(await verifyPaymentChain(h.db, a.company.id)).toMatchObject({ valid: true });
    await h.db.execute(sql`alter table payments disable trigger payments_append_only`);
    await h.db.execute(sql`update payments set method = 'cash' where company_id = ${a.company.id} and chain_seq = 2`);
    await h.db.execute(sql`alter table payments enable trigger payments_append_only`);
    const r = await verifyPaymentChain(h.db, a.company.id);
    expect(r.valid).toBe(false);
    expect(r.firstError?.reason).toMatch(/modifié/);
  });

  it("numérotation continue des justificatifs", async () => {
    const { rows } = await listPayments(h.db, a.ctx, { q: "", sort: "numero", dir: "asc", page: 1 });
    rows.forEach((p, i) => expect(p.number).toBe(`RG-2026-${String(i + 1).padStart(5, "0")}`));
  });
});

describe("isolation et droits", () => {
  it("une autre entreprise ne voit ni n'utilise les règlements et factures", async () => {
    const inv = await issuedInvoice("10");
    const own = (await listPayments(h.db, a.ctx, { q: "", sort: "numero", dir: "asc", page: 1 })).rows[0]!;
    expect((await listPayments(h.db, b.ctx, { q: "", sort: "numero", dir: "asc", page: 1 })).total).toBe(0);
    await expect(getPayment(h.db, b.ctx, own.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reversePayment(h.db, b.ctx, own.id, { idempotencyKey: randomUUID(), reason: "Tentative intrusion" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const foreignCustomer = await createThirdParty(h.db, b.ctx, { partyType: "individual", name: "Client B" });
    await expect(
      recordPayment(h.db, b.ctx, pay({ thirdPartyId: foreignCustomer.id, amount: "12", allocations: [{ documentId: inv.id, amount: "12" }] }), {
        now: NOW,
      }),
    ).rejects.toThrow(/inconnue|autre client/);
    expect((await getSalesDocument(h.db, a.ctx, inv.id)).doc.amountPaid).toBe("0.00");
  });

  it("la chaîne d'audit reste intègre", async () => {
    expect((await verifyAuditChain(h.db, a.company.id)).valid).toBe(true);
  });
});
