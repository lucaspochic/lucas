import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { salesDocumentLines, salesDocuments, users } from "@/server/db/schema";
import { addMember, listVatRates, resolveCompanyContext, updateCompany } from "@/server/services/companies";
import { registerUser } from "@/server/services/auth";
import { createThirdParty } from "@/server/services/third-parties";
import {
  convertQuoteToInvoice,
  createCreditNoteDraft,
  createDraft,
  deleteDraft,
  getSalesDocument,
  issueDocument,
  listSalesDocuments,
  respondToQuote,
  updateDraft,
  verifyDocumentIntegrity,
} from "@/server/services/sales";
import { listAuditEvents, verifyAuditChain } from "@/server/services/audit";
import type { CompanyContext } from "@/server/security/permissions";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
let a: Awaited<ReturnType<typeof createUserWithCompany>>;
let b: Awaited<ReturnType<typeof createUserWithCompany>>;
let rate20: string;
let rate55: string;
let individualId: string;
let businessNoSirenId: string;

const NOW = new Date("2026-10-20T10:00:00Z");

async function dbError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} | ${e.cause?.message ?? ""}`;
  }
  throw new Error("La requête aurait dû être refusée.");
}

const completeCompany = {
  legalName: "Atelier Ventes SAS",
  legalForm: "SAS",
  shareCapital: "10000.00",
  siren: "732829320",
  vatNumber: "FR44732829320",
  addressLine1: "1 place Bellecour",
  postalCode: "69002",
  city: "Lyon",
  paymentTermsDays: 30,
  latePenaltyText: "Pénalités : taux BCE + 10 points ; indemnité forfaitaire de 40 €.",
  invoicePrefix: "FA",
  creditNotePrefix: "AV",
  quotePrefix: "DE",
};

const line = (overrides: Record<string, unknown> = {}) => ({
  description: "Prestation",
  kind: "service",
  quantity: "2",
  unit: "heure",
  unitPriceExclTax: "50",
  vatRateId: rate20,
  ...overrides,
});

const draftInput = (overrides: Record<string, unknown> = {}) => ({
  thirdPartyId: individualId,
  lines: [line(), line({ description: "Pain", kind: "good", unit: "unité", quantity: "10", unitPriceExclTax: "1.1374", vatRateId: rate55 })],
  ...overrides,
});

beforeAll(async () => {
  h = await createTestDb();
  a = await createUserWithCompany(h, "Ventes");
  b = await createUserWithCompany(h, "Concurrent");
  await updateCompany(h.db, a.ctx, completeCompany);
  const rates = await listVatRates(h.db, a.ctx);
  rate20 = rates.find((r) => r.rate === "20.00")!.id;
  rate55 = rates.find((r) => r.rate === "5.50")!.id;
  individualId = (
    await createThirdParty(h.db, a.ctx, {
      partyType: "individual",
      name: "Jeanne Dupont",
      billingLine1: "3 rue Neuve",
      billingPostalCode: "69001",
      billingCity: "Lyon",
    })
  ).id;
  businessNoSirenId = (
    await createThirdParty(h.db, a.ctx, {
      partyType: "business",
      name: "Bâti Pro",
      billingLine1: "8 quai Est",
      billingPostalCode: "69003",
      billingCity: "Lyon",
      paymentTermsDays: "45",
    })
  ).id;
});
afterAll(async () => {
  await h.close();
});

describe("brouillons", () => {
  it("calcule les montants côté serveur, ignore tout montant envoyé par le client", async () => {
    const doc = await createDraft(h.db, a.ctx, "invoice", { ...draftInput(), totalInclTax: "1.00" });
    const { doc: saved, lines, vat } = await getSalesDocument(h.db, a.ctx, doc.id);
    // 2 × 50 = 100 HT à 20 % ; 10 × 1,1374 = 11,374 → 11,37 HT à 5,5 % (0,63 TVA)
    expect(saved).toMatchObject({ status: "draft", number: null, totalExclTax: "111.37", totalVat: "20.63", totalInclTax: "132.00", operationCategory: "mixed" });
    expect(lines.map((l) => l.totalExclTax)).toEqual(["100.00", "11.37"]);
    expect(vat.map((v) => [v.vatRate, v.baseExclTax, v.vatAmount])).toEqual([
      ["20.00", "100.00", "20.00"],
      ["5.50", "11.37", "0.63"],
    ]);
  });

  it("modifie puis supprime un brouillon", async () => {
    const doc = await createDraft(h.db, a.ctx, "quote", draftInput());
    await updateDraft(h.db, a.ctx, doc.id, { ...draftInput(), globalDiscountPercent: "10", lines: [line()] });
    expect((await getSalesDocument(h.db, a.ctx, doc.id)).doc.totalInclTax).toBe("108.00");
    await deleteDraft(h.db, a.ctx, doc.id);
    await expect(getSalesDocument(h.db, a.ctx, doc.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuse un taux de TVA ou un client d'une autre entreprise", async () => {
    const [foreignRate] = await listVatRates(h.db, b.ctx);
    await expect(createDraft(h.db, a.ctx, "invoice", draftInput({ lines: [line({ vatRateId: foreignRate!.id })] }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const foreignParty = await createThirdParty(h.db, b.ctx, { partyType: "individual", name: "Client B" });
    await expect(createDraft(h.db, a.ctx, "invoice", draftInput({ thirdPartyId: foreignParty.id }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("émission", () => {
  it("bloque l'émission si des mentions obligatoires manquent", async () => {
    const doc = await createDraft(h.db, b.ctx, "invoice", {
      thirdPartyId: (await createThirdParty(h.db, b.ctx, { partyType: "individual", name: "X", billingLine1: "1 rue", billingCity: "Paris" })).id,
      lines: [line({ vatRateId: (await listVatRates(h.db, b.ctx))[0]!.id })],
    });
    await expect(issueDocument(h.db, b.ctx, doc.id, { now: NOW })).rejects.toThrow(/SIREN de votre entreprise/);
  });

  it("émet une facture : numéro, date du jour, échéance, copies figées, empreinte", async () => {
    const draft = await createDraft(h.db, a.ctx, "invoice", draftInput());
    const issued = await issueDocument(h.db, a.ctx, draft.id, { now: NOW });
    expect(issued).toMatchObject({ status: "issued", number: "FA-2026-00001", issueDate: "2026-10-20", dueDate: "2026-11-19", fiscalYear: 2026 });
    expect(issued.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.sellerSnapshot).toMatchObject({ legalName: "Atelier Ventes SAS", siren: "732829320" });
    expect(issued.customerSnapshot).toMatchObject({ name: "Jeanne Dupont", partyType: "individual" });
    expect(await verifyDocumentIntegrity(h.db, a.ctx, draft.id)).toEqual({ valid: true, draft: false });
    const [event] = await listAuditEvents(h.db, a.ctx, { limit: 1 });
    expect(event).toMatchObject({ action: "sales_document.issued" });
    expect((event!.payload as { contentHash: string }).contentHash).toBe(issued.contentHash);
  });

  it("exige l'acceptation explicite des avertissements (SIREN client professionnel manquant)", async () => {
    const draft = await createDraft(h.db, a.ctx, "invoice", draftInput({ thirdPartyId: businessNoSirenId }));
    await expect(issueDocument(h.db, a.ctx, draft.id, { now: NOW })).rejects.toMatchObject({ code: "CONFLICT" });
    const issued = await issueDocument(h.db, a.ctx, draft.id, { now: NOW, acceptWarnings: true });
    expect(issued.number).toBe("FA-2026-00002");
    expect(issued.dueDate).toBe("2026-12-04"); // délai propre au client : 45 jours
  });

  it("change de série avec l'exercice", async () => {
    const draft = await createDraft(h.db, a.ctx, "invoice", draftInput());
    const issued = await issueDocument(h.db, a.ctx, draft.id, { now: new Date("2027-01-02T09:00:00Z") });
    expect(issued.number).toBe("FA-2027-00001");
  });

  it("émissions concurrentes : numéros uniques et continus", async () => {
    const drafts = await Promise.all(Array.from({ length: 5 }, () => createDraft(h.db, a.ctx, "invoice", draftInput())));
    const issued = await Promise.all(drafts.map((d) => issueDocument(h.db, a.ctx, d.id, { now: NOW })));
    expect(issued.map((d) => d.number).sort()).toEqual(["FA-2026-00003", "FA-2026-00004", "FA-2026-00005", "FA-2026-00006", "FA-2026-00007"]);
  });
});

describe("inaltérabilité d'un document émis", () => {
  let issuedId: string;
  beforeAll(async () => {
    issuedId = (await issueDocument(h.db, a.ctx, (await createDraft(h.db, a.ctx, "invoice", draftInput())).id, { now: NOW })).id;
  });

  it("le service refuse toute modification ou suppression", async () => {
    await expect(updateDraft(h.db, a.ctx, issuedId, draftInput())).rejects.toMatchObject({ code: "IMMUTABLE" });
    await expect(deleteDraft(h.db, a.ctx, issuedId)).rejects.toMatchObject({ code: "IMMUTABLE" });
    await expect(issueDocument(h.db, a.ctx, issuedId, { now: NOW })).rejects.toMatchObject({ code: "IMMUTABLE" });
  });

  it("la base refuse la modification des montants, des lignes et la suppression", async () => {
    expect(await dbError(h.db.update(salesDocuments).set({ totalInclTax: "1.00" }).where(eq(salesDocuments.id, issuedId)))).toMatch(
      /modification interdite/,
    );
    expect(await dbError(h.db.update(salesDocuments).set({ number: "FA-2026-99999" }).where(eq(salesDocuments.id, issuedId)))).toMatch(
      /modification interdite/,
    );
    expect(await dbError(h.db.update(salesDocumentLines).set({ quantity: "1" }).where(eq(salesDocumentLines.documentId, issuedId)))).toMatch(
      /lignes/,
    );
    expect(await dbError(h.db.delete(salesDocumentLines).where(eq(salesDocumentLines.documentId, issuedId)))).toMatch(/lignes/);
    expect(await dbError(h.db.delete(salesDocuments).where(eq(salesDocuments.id, issuedId)))).toMatch(/suppression interdite/);
    expect(await dbError(h.db.update(salesDocuments).set({ status: "draft" }).where(eq(salesDocuments.id, issuedId)))).toMatch(
      /transition/,
    );
  });

  it("les colonnes de suivi restent modifiables (montant réglé)", async () => {
    await h.db.update(salesDocuments).set({ amountPaid: "10.00" }).where(eq(salesDocuments.id, issuedId));
    expect((await getSalesDocument(h.db, a.ctx, issuedId)).doc.amountPaid).toBe("10.00");
    expect((await verifyDocumentIntegrity(h.db, a.ctx, issuedId)).valid).toBe(true);
  });

  it("une altération contournant les triggers est détectée par l'empreinte", async () => {
    await h.db.execute(sql`alter table sales_document_lines disable trigger sales_document_lines_guard`);
    await h.db.execute(sql`update sales_document_lines set unit_price_excl_tax = 1 where document_id = ${issuedId} and position = 1`);
    await h.db.execute(sql`alter table sales_document_lines enable trigger sales_document_lines_guard`);
    expect((await verifyDocumentIntegrity(h.db, a.ctx, issuedId)).valid).toBe(false);
  });
});

describe("devis", () => {
  it("émis, accepté, transformé en facture une seule fois", async () => {
    const quote = await issueDocument(h.db, a.ctx, (await createDraft(h.db, a.ctx, "quote", draftInput())).id, { now: NOW });
    expect(quote).toMatchObject({ number: "DE-2026-00001", dueDate: "2026-11-19" });
    await respondToQuote(h.db, a.ctx, quote.id, "accepted");
    await expect(respondToQuote(h.db, a.ctx, quote.id, "refused")).rejects.toMatchObject({ code: "VALIDATION" });
    const first = await convertQuoteToInvoice(h.db, a.ctx, quote.id);
    const second = await convertQuoteToInvoice(h.db, a.ctx, quote.id);
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    const invoice = await getSalesDocument(h.db, a.ctx, first.id);
    expect(invoice.doc).toMatchObject({ type: "invoice", status: "draft", sourceDocumentId: quote.id, totalInclTax: quote.totalInclTax });
    expect(invoice.lines).toHaveLength(2);
  });

  it("un devis refusé ne peut pas être facturé ; une facture ne peut pas être « acceptée »", async () => {
    const quote = await issueDocument(h.db, a.ctx, (await createDraft(h.db, a.ctx, "quote", draftInput())).id, { now: NOW });
    await respondToQuote(h.db, a.ctx, quote.id, "refused");
    await expect(convertQuoteToInvoice(h.db, a.ctx, quote.id)).rejects.toMatchObject({ code: "VALIDATION" });
    const [inv] = (await listSalesDocuments(h.db, a.ctx, { type: "invoice", status: "issued", q: "", sort: "numero", dir: "asc", page: 1 })).rows;
    expect(await dbError(h.db.update(salesDocuments).set({ status: "accepted" }).where(eq(salesDocuments.id, inv!.id)))).toMatch(/transition|ck/);
  });
});

describe("avoirs", () => {
  it("avoir total puis refus de tout avoir supplémentaire", async () => {
    const invoice = await issueDocument(h.db, a.ctx, (await createDraft(h.db, a.ctx, "invoice", draftInput())).id, { now: NOW });
    const credit = await createCreditNoteDraft(h.db, a.ctx, invoice.id);
    const issuedCredit = await issueDocument(h.db, a.ctx, credit.id, { now: NOW });
    expect(issuedCredit).toMatchObject({ number: "AV-2026-00001", totalInclTax: invoice.totalInclTax, sourceDocumentId: invoice.id, dueDate: null });
    const extra = await createCreditNoteDraft(h.db, a.ctx, invoice.id);
    await expect(issueDocument(h.db, a.ctx, extra.id, { now: NOW })).rejects.toThrow(/dépasse le montant restant/);
  });

  it("avoirs partiels dans la limite du montant de la facture", async () => {
    const invoice = await issueDocument(h.db, a.ctx, (await createDraft(h.db, a.ctx, "invoice", draftInput({ lines: [line()] }))).id, { now: NOW });
    expect(invoice.totalInclTax).toBe("120.00");
    const c1 = await createCreditNoteDraft(h.db, a.ctx, invoice.id);
    await updateDraft(h.db, a.ctx, c1.id, { thirdPartyId: individualId, lines: [line({ quantity: "1" })] });
    expect((await issueDocument(h.db, a.ctx, c1.id, { now: NOW })).totalInclTax).toBe("60.00");
    const c2 = await createCreditNoteDraft(h.db, a.ctx, invoice.id);
    await updateDraft(h.db, a.ctx, c2.id, { thirdPartyId: individualId, lines: [line({ quantity: "1.5" })] });
    await expect(issueDocument(h.db, a.ctx, c2.id, { now: NOW })).rejects.toThrow(/60.00/);
    await expect(updateDraft(h.db, a.ctx, c2.id, { thirdPartyId: businessNoSirenId, lines: [line()] })).rejects.toThrow(/client d'un avoir/);
  });

  it("pas d'avoir sur un brouillon ou un devis", async () => {
    const draft = await createDraft(h.db, a.ctx, "invoice", draftInput());
    await expect(createCreditNoteDraft(h.db, a.ctx, draft.id)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("isolation et droits", () => {
  it("une autre entreprise ne voit ni ne manipule les documents", async () => {
    const [inv] = (await listSalesDocuments(h.db, a.ctx, { type: "invoice", status: "issued", q: "", sort: "numero", dir: "asc", page: 1 })).rows;
    const visibleToB = (await listSalesDocuments(h.db, b.ctx, { type: "invoice", q: "", sort: "numero", dir: "asc", page: 1 })).rows;
    expect(visibleToB.every((d) => d.companyId === b.company.id)).toBe(true);
    expect(visibleToB.some((d) => d.id === inv!.id)).toBe(false);
    await expect(getSalesDocument(h.db, b.ctx, inv!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createCreditNoteDraft(h.db, b.ctx, inv!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(issueDocument(h.db, b.ctx, inv!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("un comptable consulte mais n'émet pas ; un commercial émet", async () => {
    const ctxFor = async (email: string, role: "accountant" | "sales"): Promise<CompanyContext> => {
      const u = await registerUser(h.db, { fullName: role, email, password: "motdepasse-long-12" });
      await addMember(h.db, a.ctx, { email, role });
      return (await resolveCompanyContext(h.db, u.id, a.company.id))!;
    };
    const accountant = await ctxFor("compta.ventes@exemple.fr", "accountant");
    const sales = await ctxFor("commercial.ventes@exemple.fr", "sales");
    const draft = await createDraft(h.db, sales, "invoice", draftInput());
    await expect(createDraft(h.db, accountant, "invoice", draftInput())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(issueDocument(h.db, accountant, draft.id, { now: NOW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await getSalesDocument(h.db, accountant, draft.id)).doc.id).toBe(draft.id);
    expect((await issueDocument(h.db, sales, draft.id, { now: NOW })).status).toBe("issued");
    const [creator] = await h.db.select().from(users).where(and(eq(users.email, "commercial.ventes@exemple.fr")));
    expect((await getSalesDocument(h.db, a.ctx, draft.id)).doc.issuedBy).toBe(creator!.id);
  });

  it("la chaîne d'audit reste intègre", async () => {
    expect((await verifyAuditChain(h.db, a.company.id)).valid).toBe(true);
  });
});
