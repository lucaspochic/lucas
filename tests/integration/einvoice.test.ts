import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/server/db/client";
import { listVatRates, updateCompany } from "@/server/services/companies";
import { createThirdParty } from "@/server/services/third-parties";
import { convertQuoteToInvoice, createCreditNoteDraft, createDepositDraft, createDraft, issueDocument } from "@/server/services/sales";
import { exportCii, exportPdf } from "@/server/services/einvoice";
import { PDFDocument } from "pdf-lib";
import { postalOf } from "@/server/domain/cii";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
const NOW = { now: new Date("2026-10-21T10:00:00Z") };

/** Contrôle de bonne formation : balises équilibrées, entités valides. */
function assertWellFormed(xml: string) {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) expect(stack.pop(), `fermeture de ${m[2]}`).toBe(m[2]);
    else stack.push(m[2]!);
  }
  expect(stack).toEqual([]);
  expect(xml.replace(/&(amp|lt|gt|quot|apos);/g, "")).not.toMatch(/&/);
}
const values = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<ram:${tag}(?: [^>]*)?>([^<]*)</ram:${tag}>`, "g"))].map((m) => m[1]!);
const sum = (vals: string[]) => vals.reduce((a, v) => a + Math.round(Number(v) * 100), 0) / 100;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("export CII (EN 16931)", () => {
  it("facture avec remises de ligne et globale, deux taux, avoir et acomptes : montants cohérents", async () => {
    const c = await createUserWithCompany(h, "Cii");
    await updateCompany(h.db, c.ctx, {
      legalName: "Atelier & Fils SAS",
      legalForm: "SAS",
      shareCapital: "10000",
      rcsCity: "Lyon",
      siren: "732829320",
      vatNumber: "FR44732829320",
      addressLine1: "1 rue des Lilas",
      postalCode: "69001",
      city: "Lyon",
      iban: "FR76 3000 6000 0112 3456 7890 189",
      paymentTermsDays: 30,
      latePenaltyText: "Pénalités : trois fois le taux d'intérêt légal.",
      invoicePrefix: "FA",
      creditNotePrefix: "AV",
      quotePrefix: "DE",
      vatOnDebits: true,
    });
    const rates = await listVatRates(h.db, c.ctx);
    const r20 = rates.find((r) => r.rate === "20.00")!.id;
    const r55 = rates.find((r) => r.rate === "5.50")!.id;
    const customer = await createThirdParty(h.db, c.ctx, {
      partyType: "business",
      name: "Client <Pro> & Cie",
      siren: "552100554",
      billingLine1: "10 avenue Foch",
      billingPostalCode: "75016",
      billingCity: "Paris",
    });
    const lines = [
      { description: "Conseil", kind: "service", quantity: "3", unit: "heure", unitPriceExclTax: "83.33", discountPercent: "5", vatRateId: r20 },
      { description: "Livre", kind: "good", quantity: "2", unit: "unité", unitPriceExclTax: "19.99", vatRateId: r55 },
    ];
    const inv = await issueDocument(h.db, c.ctx, (await createDraft(h.db, c.ctx, "invoice", { thirdPartyId: customer.id, globalDiscountPercent: "10", lines })).id, NOW);
    const { xml, fileName } = await exportCii(h.db, c.ctx, inv.id);
    expect(fileName).toBe(`${inv.number}.xml`);
    assertWellFormed(xml);
    expect(xml).toContain("<ram:ID>urn:cen.eu:en16931:2017</ram:ID>");
    expect(xml).toContain("<ram:TypeCode>380</ram:TypeCode>");
    expect(xml).toContain('<ram:ID schemeID="0002">732829320</ram:ID>');
    expect(xml).toContain('<ram:ID schemeID="0002">552100554</ram:ID>');
    expect(xml).toContain("<ram:Name>Client &lt;Pro&gt; &amp; Cie</ram:Name>");
    expect(xml).toContain("<ram:PostcodeCode>75016</ram:PostcodeCode><ram:LineOne>10 avenue Foch</ram:LineOne><ram:CityName>Paris</ram:CityName><ram:CountryID>FR</ram:CountryID>");
    expect(xml).toContain('<ram:BilledQuantity unitCode="HUR">3.000</ram:BilledQuantity>');
    expect(xml).toContain("<ram:IBANID>FR7630006000011234567890189</ram:IBANID>");
    expect(xml).toContain("<ram:DueDateTypeCode>5</ram:DueDateTypeCode>"); // option sur les débits
    expect(xml).toContain("<ram:SubjectCode>PMT</ram:SubjectCode>"); // client professionnel : indemnité de 40 €

    // BR-CO-10 : Σ montants nets des lignes = total des lignes ; BR-CO-13 : base = lignes − remises.
    const lineTotals = values(xml, "LineTotalAmount");
    const header = lineTotals.pop()!;
    expect(sum(lineTotals)).toBe(Number(header));
    const allowance = values(xml, "AllowanceTotalAmount")[0]!;
    expect((Math.round(Number(header) * 100) - Math.round(Number(allowance) * 100)) / 100).toBe(Number(inv.totalExclTax));
    expect(values(xml, "TaxBasisTotalAmount")).toEqual([inv.totalExclTax]);
    // BR-CO-14 : Σ TVA par taux = TVA totale ; BR-CO-15 : TTC = base + TVA.
    expect(sum(values(xml, "CalculatedAmount"))).toBe(Number(inv.totalVat));
    expect(values(xml, "GrandTotalAmount")).toEqual([inv.totalInclTax]);
    expect(values(xml, "DuePayableAmount")).toEqual([inv.totalInclTax]);
    // Remise globale ventilée par taux = écart entre bases avant et après remise.
    expect(sum(values(xml, "ActualAmount").slice(-2))).toBe(Number(allowance));

    const credit = await issueDocument(h.db, c.ctx, (await createCreditNoteDraft(h.db, c.ctx, inv.id)).id, NOW);
    const cn = (await exportCii(h.db, c.ctx, credit.id)).xml;
    assertWellFormed(cn);
    expect(cn).toContain("<ram:TypeCode>381</ram:TypeCode>");
    expect(cn).toContain(`<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${inv.number}</ram:IssuerAssignedID><ram:FormattedIssueDateTime><qdt:DateTimeString format="102">20261021</qdt:DateTimeString>`);

    // Acompte (386) puis solde avec lignes négatives.
    const quote = await issueDocument(h.db, c.ctx, (await createDraft(h.db, c.ctx, "quote", { thirdPartyId: customer.id, globalDiscountPercent: "10", lines })).id, NOW);
    const dep = await issueDocument(h.db, c.ctx, (await createDepositDraft(h.db, c.ctx, quote.id, { percent: "40" })).id, NOW);
    expect((await exportCii(h.db, c.ctx, dep.id)).xml).toContain("<ram:TypeCode>386</ram:TypeCode>");
    const final = await issueDocument(h.db, c.ctx, (await convertQuoteToInvoice(h.db, c.ctx, quote.id)).id, NOW);
    const fx = (await exportCii(h.db, c.ctx, final.id)).xml;
    assertWellFormed(fx);
    expect(fx).toMatch(/<ram:BilledQuantity unitCode="LS">-1\.000<\/ram:BilledQuantity>/);
    expect(values(fx, "TaxBasisTotalAmount")).toEqual([final.totalExclTax]);
    expect(values(fx, "GrandTotalAmount")).toEqual([final.totalInclTax]);
    await expect(exportCii(h.db, c.ctx, quote.id)).rejects.toThrow("factures et les avoirs");
  });

  it("PDF serveur : document lisible, pagination, caractères hors police remplacés, brouillon refusé", async () => {
    const c = await createUserWithCompany(h, "Pdf");
    await updateCompany(h.db, c.ctx, { legalName: "Pdf SAS", siren: "732829320", vatNumber: "FR44732829320", addressLine1: "1 rue", postalCode: "69001", city: "Lyon", paymentTermsDays: 30, latePenaltyText: "Pénalités.", invoicePrefix: "FA", creditNotePrefix: "AV", quotePrefix: "DE" });
    const r20 = (await listVatRates(h.db, c.ctx)).find((r) => r.rate === "20.00")!.id;
    const customer = await createThirdParty(h.db, c.ctx, { partyType: "individual", name: "Zoé Ærø", billingLine1: "2 rue", billingCity: "Lyon" });
    const lines = Array.from({ length: 60 }, (_, i) => ({
      description: i === 0 ? "Désignation longue « avec guillemets » — tiret, œuvre, 中文 et flèche → " + "très ".repeat(40) : `Article ${i + 1}`,
      kind: "service",
      quantity: "1",
      unit: "unité",
      unitPriceExclTax: "10",
      vatRateId: r20,
    }));
    const draft = await createDraft(h.db, c.ctx, "invoice", { thirdPartyId: customer.id, lines });
    await expect(exportPdf(h.db, c.ctx, draft.id)).rejects.toThrow("brouillon");
    const inv = await issueDocument(h.db, c.ctx, draft.id, NOW);
    const { bytes, fileName } = await exportPdf(h.db, c.ctx, inv.id);
    expect(fileName).toBe(`${inv.number}.pdf`);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getTitle()).toBe(`Facture n° ${inv.number}`);
    expect(loaded.getPageCount()).toBeGreaterThan(1);
  });

  it("adresse des documents anciens : lecture des lignes figées", () => {
    expect(postalOf({ billingAddress: ["2 rue", "Bât. B", "69001 Lyon"] })).toEqual({ line1: "2 rue", line2: "Bât. B", postalCode: "69001", city: "Lyon", country: "FR" });
    expect(postalOf({ address: ["Rue X 5", "1000 Bruxelles", "BE"] })).toEqual({ line1: "Rue X 5", line2: null, postalCode: "1000", city: "Bruxelles", country: "BE" });
    expect(postalOf({ billingAddress: [] })).toEqual({ line1: null, line2: null, postalCode: null, city: null, country: "FR" });
  });
});
