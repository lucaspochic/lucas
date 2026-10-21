import { D, dec, roundMoney } from "./money";
import type { CustomerSnapshot, PostalAddress, SellerSnapshot } from "./sales";

/**
 * Export d'une facture ou d'un avoir au format UN/CEFACT Cross Industry Invoice (CII D16B),
 * profil de la norme européenne EN 16931 (identifiant urn:cen.eu:en16931:2017).
 *
 * Choix de représentation (cohérents avec les règles de calcul du logiciel) :
 *  - remise de ligne : remise de ligne (BG-27) ; prix net = prix unitaire HT ;
 *  - remise globale : remise au niveau du document (BG-20), une par taux de TVA ;
 *  - facture d'acompte : type 386 ; facture de solde : lignes négatives de déduction ;
 *  - avoir : type 381, montants positifs, référence à la facture d'origine (BG-3) ;
 *  - taux nul : catégorie E (exonération) avec le motif saisi en clair.
 *
 * Ce fichier n'a pas été soumis aux outils de validation officiels (XSD, Schematron EN 16931,
 * règles françaises) : à faire avec la plateforme agréée retenue avant tout usage réel.
 * Il ne constitue pas, seul, une facture électronique Factur-X (PDF/A-3 + XML).
 */

export interface CiiLine {
  position: number;
  reference: string | null;
  description: string;
  quantity: string;
  unit: string;
  unitPriceExclTax: string;
  discountPercent: string;
  vatRate: string;
  vatExemptionReason: string | null;
  /** Total HT de ligne après remise de ligne, avant remise globale. */
  totalExclTax: string;
  /** Ligne exclue de la remise globale (déduction d'acompte). */
  noGlobalDiscount: boolean;
}

export interface CiiVat {
  vatRate: string;
  vatExemptionReason: string | null;
  baseExclTax: string;
  vatAmount: string;
}

export interface CiiInput {
  type: "invoice" | "credit_note";
  isDeposit: boolean;
  number: string;
  issueDate: string;
  dueDate: string | null;
  deliveryDate: string | null;
  currency: string;
  globalDiscountPercent: string;
  totalExclTax: string;
  totalVat: string;
  totalInclTax: string;
  seller: SellerSnapshot;
  customer: CustomerSnapshot;
  lines: CiiLine[];
  vat: CiiVat[];
  sourceNumber: string | null;
  sourceIssueDate: string | null;
}

/** Codes d'unité UN/ECE (recommandations 20 et 21). */
export const UNIT_CODES: Record<string, string> = {
  unité: "C62",
  heure: "HUR",
  jour: "DAY",
  forfait: "LS",
  mois: "MON",
  kg: "KGM",
  g: "GRM",
  litre: "LTR",
  m: "MTR",
  "m²": "MTK",
  "m³": "MTQ",
  lot: "XLT",
};

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const date102 = (iso: string) => iso.replaceAll("-", "");
const amount = (v: string | ReturnType<typeof dec>) => dec(typeof v === "string" ? v : v.toString()).toFixed(2);
const category = (rate: string) => (dec(rate).isZero() ? "E" : "S");

/** Adresse structurée ; à défaut (document ancien), lecture des lignes figées « CP Ville ». */
export function postalOf(snapshot: { postal?: PostalAddress | null; address?: string[]; billingAddress?: string[] }): PostalAddress {
  if (snapshot.postal) return snapshot.postal;
  const lines = [...(snapshot.address ?? snapshot.billingAddress ?? [])];
  let country = "FR";
  if (lines.length && /^[A-Z]{2}$/.test(lines[lines.length - 1]!)) country = lines.pop()!;
  const cityLine = lines.length ? lines[lines.length - 1]! : "";
  const m = /^(\S+)\s+(.+)$/.exec(cityLine);
  const hasCity = !!m && /\d/.test(m[1]!);
  const street = hasCity ? lines.slice(0, -1) : lines;
  return { line1: street[0] ?? null, line2: street[1] ?? null, postalCode: hasCity ? m![1]! : null, city: hasCity ? m![2]! : null, country };
}

function addressXml(p: PostalAddress) {
  return [
    "<ram:PostalTradeAddress>",
    p.postalCode ? `<ram:PostcodeCode>${esc(p.postalCode)}</ram:PostcodeCode>` : "",
    p.line1 ? `<ram:LineOne>${esc(p.line1)}</ram:LineOne>` : "",
    p.line2 ? `<ram:LineTwo>${esc(p.line2)}</ram:LineTwo>` : "",
    p.city ? `<ram:CityName>${esc(p.city)}</ram:CityName>` : "",
    `<ram:CountryID>${esc(p.country || "FR")}</ram:CountryID>`,
    "</ram:PostalTradeAddress>",
  ].join("");
}

function sellerXml(s: SellerSnapshot) {
  return [
    "<ram:SellerTradeParty>",
    `<ram:Name>${esc(s.legalName)}</ram:Name>`,
    s.siren || s.tradeName
      ? `<ram:SpecifiedLegalOrganization>${s.siren ? `<ram:ID schemeID="0002">${esc(s.siren)}</ram:ID>` : ""}${s.tradeName ? `<ram:TradingBusinessName>${esc(s.tradeName)}</ram:TradingBusinessName>` : ""}</ram:SpecifiedLegalOrganization>`
      : "",
    addressXml(postalOf(s)),
    s.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(s.email)}</ram:URIID></ram:URIUniversalCommunication>` : "",
    s.vatNumber ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(s.vatNumber)}</ram:ID></ram:SpecifiedTaxRegistration>` : "",
    "</ram:SellerTradeParty>",
  ].join("");
}

function buyerXml(c: CustomerSnapshot) {
  return [
    "<ram:BuyerTradeParty>",
    `<ram:Name>${esc(c.name)}</ram:Name>`,
    c.siren ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${esc(c.siren)}</ram:ID></ram:SpecifiedLegalOrganization>` : "",
    addressXml(postalOf(c)),
    c.vatNumber ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(c.vatNumber)}</ram:ID></ram:SpecifiedTaxRegistration>` : "",
    "</ram:BuyerTradeParty>",
  ].join("");
}

const indicator = (charge: boolean) => `<ram:ChargeIndicator><udt:Indicator>${charge}</udt:Indicator></ram:ChargeIndicator>`;

export function buildCii(input: CiiInput) {
  const HUNDRED = new D(100);
  const global = dec(input.globalDiscountPercent);
  // Remise globale par taux : avant − après remise globale, sur les lignes concernées.
  const allowanceByRate = new Map<string, { rate: string; reason: string | null; amount: ReturnType<typeof dec> }>();
  let lineTotal = new D(0);
  const linesXml = input.lines.map((l) => {
    const total = dec(l.totalExclTax);
    lineTotal = lineTotal.plus(total);
    if (!global.isZero() && !l.noGlobalDiscount) {
      const after = roundMoney(total.times(HUNDRED.minus(global)).dividedBy(HUNDRED));
      const key = `${dec(l.vatRate).toFixed(2)}|${l.vatExemptionReason ?? ""}`;
      const cur = allowanceByRate.get(key) ?? { rate: l.vatRate, reason: l.vatExemptionReason, amount: new D(0) };
      cur.amount = cur.amount.plus(total.minus(after));
      allowanceByRate.set(key, cur);
    }
    const gross = roundMoney(dec(l.quantity).times(l.unitPriceExclTax));
    const lineAllowance = gross.minus(total);
    return [
      "<ram:IncludedSupplyChainTradeLineItem>",
      `<ram:AssociatedDocumentLineDocument><ram:LineID>${l.position}</ram:LineID></ram:AssociatedDocumentLineDocument>`,
      `<ram:SpecifiedTradeProduct>${l.reference ? `<ram:SellerAssignedID>${esc(l.reference)}</ram:SellerAssignedID>` : ""}<ram:Name>${esc(l.description)}</ram:Name></ram:SpecifiedTradeProduct>`,
      `<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>${dec(l.unitPriceExclTax).toFixed(4)}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>`,
      `<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${UNIT_CODES[l.unit] ?? "C62"}">${dec(l.quantity).toFixed(3)}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>`,
      "<ram:SpecifiedLineTradeSettlement>",
      `<ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>${category(l.vatRate)}</ram:CategoryCode><ram:RateApplicablePercent>${dec(l.vatRate).toFixed(2)}</ram:RateApplicablePercent></ram:ApplicableTradeTax>`,
      lineAllowance.isZero()
        ? ""
        : `<ram:SpecifiedTradeAllowanceCharge>${indicator(false)}<ram:ActualAmount>${amount(lineAllowance)}</ram:ActualAmount><ram:Reason>Remise</ram:Reason></ram:SpecifiedTradeAllowanceCharge>`,
      `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amount(total)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>`,
      "</ram:SpecifiedLineTradeSettlement>",
      "</ram:IncludedSupplyChainTradeLineItem>",
    ].join("");
  });
  const allowances = [...allowanceByRate.values()].filter((a) => !a.amount.isZero());
  const allowanceTotal = allowances.reduce((acc, a) => acc.plus(a.amount), new D(0));

  const s = input.seller;
  const notes: [string, string][] = [];
  if (s.latePenaltyText) notes.push(["PMD", s.latePenaltyText]);
  if (input.customer.partyType !== "individual") notes.push(["PMT", "Indemnité forfaitaire pour frais de recouvrement en cas de retard de paiement : 40 €."]);
  const legal = [s.legalForm, s.shareCapital ? `au capital de ${dec(s.shareCapital).toFixed(2)} €` : null, s.rcsCity && s.siren ? `RCS ${s.rcsCity} ${s.siren}` : null, s.legalMentions].filter(Boolean).join(" — ");
  if (legal) notes.push(["REG", legal]);

  const typeCode = input.type === "credit_note" ? "381" : input.isDeposit ? "386" : "380";
  const taxBasis = lineTotal.minus(allowanceTotal);
  const shipping = input.customer.shippingPostal ?? (input.customer.shippingAddress ? postalOf({ billingAddress: input.customer.shippingAddress }) : null);

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',
    "<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>",
    "<rsm:ExchangedDocument>",
    `<ram:ID>${esc(input.number)}</ram:ID>`,
    `<ram:TypeCode>${typeCode}</ram:TypeCode>`,
    `<ram:IssueDateTime><udt:DateTimeString format="102">${date102(input.issueDate)}</udt:DateTimeString></ram:IssueDateTime>`,
    ...notes.map(([code, text]) => `<ram:IncludedNote><ram:Content>${esc(text)}</ram:Content><ram:SubjectCode>${code}</ram:SubjectCode></ram:IncludedNote>`),
    "</rsm:ExchangedDocument>",
    "<rsm:SupplyChainTradeTransaction>",
    ...linesXml,
    "<ram:ApplicableHeaderTradeAgreement>",
    sellerXml(s),
    buyerXml(input.customer),
    "</ram:ApplicableHeaderTradeAgreement>",
    "<ram:ApplicableHeaderTradeDelivery>",
    shipping ? `<ram:ShipToTradeParty><ram:Name>${esc(input.customer.name)}</ram:Name>${addressXml(shipping)}</ram:ShipToTradeParty>` : "",
    input.deliveryDate
      ? `<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">${date102(input.deliveryDate)}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>`
      : "",
    "</ram:ApplicableHeaderTradeDelivery>",
    "<ram:ApplicableHeaderTradeSettlement>",
    `<ram:InvoiceCurrencyCode>${esc(input.currency)}</ram:InvoiceCurrencyCode>`,
    s.iban
      ? `<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${esc(s.iban.replace(/\s/g, ""))}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>`
      : "",
    ...input.vat.map((v) =>
      [
        "<ram:ApplicableTradeTax>",
        `<ram:CalculatedAmount>${amount(v.vatAmount)}</ram:CalculatedAmount>`,
        "<ram:TypeCode>VAT</ram:TypeCode>",
        v.vatExemptionReason ? `<ram:ExemptionReason>${esc(v.vatExemptionReason)}</ram:ExemptionReason>` : "",
        `<ram:BasisAmount>${amount(v.baseExclTax)}</ram:BasisAmount>`,
        `<ram:CategoryCode>${category(v.vatRate)}</ram:CategoryCode>`,
        // Option pour le paiement de la TVA d'après les débits : date de la facture (code 5).
        s.vatOnDebits && !dec(v.vatRate).isZero() ? "<ram:DueDateTypeCode>5</ram:DueDateTypeCode>" : "",
        `<ram:RateApplicablePercent>${dec(v.vatRate).toFixed(2)}</ram:RateApplicablePercent>`,
        "</ram:ApplicableTradeTax>",
      ].join(""),
    ),
    ...allowances.map(
      (a) =>
        `<ram:SpecifiedTradeAllowanceCharge>${indicator(false)}<ram:ActualAmount>${amount(a.amount)}</ram:ActualAmount><ram:Reason>Remise globale</ram:Reason><ram:CategoryTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>${category(a.rate)}</ram:CategoryCode><ram:RateApplicablePercent>${dec(a.rate).toFixed(2)}</ram:RateApplicablePercent></ram:CategoryTradeTax></ram:SpecifiedTradeAllowanceCharge>`,
    ),
    input.dueDate && input.type === "invoice"
      ? `<ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">${date102(input.dueDate)}</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>`
      : "",
    "<ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
    `<ram:LineTotalAmount>${amount(lineTotal)}</ram:LineTotalAmount>`,
    allowanceTotal.isZero() ? "" : `<ram:AllowanceTotalAmount>${amount(allowanceTotal)}</ram:AllowanceTotalAmount>`,
    `<ram:TaxBasisTotalAmount>${amount(taxBasis)}</ram:TaxBasisTotalAmount>`,
    `<ram:TaxTotalAmount currencyID="${esc(input.currency)}">${amount(input.totalVat)}</ram:TaxTotalAmount>`,
    `<ram:GrandTotalAmount>${amount(input.totalInclTax)}</ram:GrandTotalAmount>`,
    "<ram:TotalPrepaidAmount>0.00</ram:TotalPrepaidAmount>",
    `<ram:DuePayableAmount>${amount(input.totalInclTax)}</ram:DuePayableAmount>`,
    "</ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
    input.sourceNumber && input.type === "credit_note"
      ? `<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${esc(input.sourceNumber)}</ram:IssuerAssignedID>${input.sourceIssueDate ? `<ram:FormattedIssueDateTime><qdt:DateTimeString format="102">${date102(input.sourceIssueDate)}</qdt:DateTimeString></ram:FormattedIssueDateTime>` : ""}</ram:InvoiceReferencedDocument>`
      : "",
    "</ram:ApplicableHeaderTradeSettlement>",
    "</rsm:SupplyChainTradeTransaction>",
    "</rsm:CrossIndustryInvoice>",
  ]
    .filter(Boolean)
    .join("\n");

  // Contrôles de cohérence (règles BR-CO de la norme) : une incohérence est une erreur du logiciel.
  if (!taxBasis.equals(dec(input.totalExclTax))) throw new Error(`CII : base HT incohérente (${taxBasis.toFixed(2)} ≠ ${input.totalExclTax}).`);
  if (!dec(input.totalExclTax).plus(input.totalVat).equals(dec(input.totalInclTax))) throw new Error("CII : total TTC incohérent.");
  return xml;
}
