import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { SalesDocument, SalesDocumentLine } from "../db/schema";
import { dec, formatEuro, formatRate, formatUnitPrice } from "../domain/money";
import { documentLabel, type CustomerSnapshot, type SellerSnapshot } from "../domain/sales";

/**
 * PDF d'un devis, d'une facture ou d'un avoir émis, produit par le serveur (même contenu et
 * mêmes mentions que la version imprimable). Polices standard (Helvetica, jeu WinAnsi) :
 * un caractère hors de ce jeu est remplacé par « ? » plutôt que de faire échouer l'export.
 * Document de consultation : ce n'est pas une facture électronique Factur-X (PDF/A-3).
 */

const A4 = { w: 595.28, h: 841.89 };
const M = 42; // marges
const INK = rgb(0.12, 0.14, 0.19);
const MUTED = rgb(0.36, 0.4, 0.46);
const RULE = rgb(0.82, 0.84, 0.87);
const CATEGORY = { goods: "livraison de biens", services: "prestation de services", mixed: "livraison de biens et prestation de services" } as const;
const date = (iso: string) => iso.split("-").reverse().join("/");

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(
    private pdf: PDFDocument,
    public font: PDFFont,
    public bold: PDFFont,
    private footer: string[],
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.pdf.addPage([A4.w, A4.h]);
    this.pages.push(this.page);
    this.y = A4.h - M;
  }

  /** Remplace les caractères non encodables par la police standard. */
  clean(text: string, font = this.font) {
    let out = "";
    for (const ch of text.replace(/[   ]/g, " ").replace(/\t/g, " ")) {
      try {
        font.encodeText(ch);
        out += ch;
      } catch {
        out += "?";
      }
    }
    return out;
  }

  width(text: string, size: number, font = this.font) {
    return font.widthOfTextAtSize(this.clean(text, font), size);
  }

  /** Découpe un texte en lignes tenant dans `max` points (mots, puis caractères si besoin). */
  wrap(text: string, size: number, max: number, font = this.font) {
    const out: string[] = [];
    for (const para of text.split(/\r?\n/)) {
      let line = "";
      for (const word of para.split(" ")) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.width(candidate, size, font) <= max) {
          line = candidate;
          continue;
        }
        if (line) out.push(line);
        line = word;
        while (this.width(line, size, font) > max && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && this.width(line.slice(0, cut), size, font) > max) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      out.push(line);
    }
    return out;
  }

  text(text: string, x: number, y: number, size: number, opts: { font?: PDFFont; color?: ReturnType<typeof rgb>; align?: "left" | "right" } = {}) {
    const font = opts.font ?? this.font;
    const t = this.clean(text, font);
    const dx = opts.align === "right" ? x - font.widthOfTextAtSize(t, size) : x;
    this.page.drawText(t, { x: dx, y, size, font, color: opts.color ?? INK });
  }

  rule(y: number, x1 = M, x2 = A4.w - M) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.6, color: RULE });
  }

  /** Réserve `h` points sur la page, ou passe à la suivante. */
  ensure(h: number) {
    if (this.y - h < M + 60) {
      this.newPage();
      return true;
    }
    return false;
  }

  finish() {
    this.pages.forEach((p, i) => {
      let y = M + 22;
      for (const l of this.footer) {
        const t = this.clean(l);
        p.drawText(t, { x: M, y, size: 7, font: this.font, color: MUTED });
        y -= 9;
      }
      const label = `Page ${i + 1} / ${this.pages.length}`;
      p.drawText(label, { x: A4.w - M - this.font.widthOfTextAtSize(label, 7), y: M - 14, size: 7, font: this.font, color: MUTED });
    });
  }
}

export async function renderSalesDocumentPdf(input: { doc: SalesDocument; lines: SalesDocumentLine[]; vat: { vatRate: string; vatExemptionReason: string | null; baseExclTax: string; vatAmount: string }[]; sourceNumber: string | null }) {
  const { doc, lines, vat, sourceNumber } = input;
  const seller = doc.sellerSnapshot as SellerSnapshot;
  const customer = doc.customerSnapshot as CustomerSnapshot;
  const pdf = await PDFDocument.create();
  const title = `${documentLabel(doc)} n° ${doc.number}`;
  pdf.setTitle(title);
  pdf.setAuthor(seller.legalName);
  pdf.setCreator("Gestion");
  pdf.setProducer("Gestion (pdf-lib)");
  pdf.setCreationDate(doc.issuedAt ?? new Date());

  const legal = [
    seller.legalName,
    seller.legalForm && seller.shareCapital ? `${seller.legalForm} au capital de ${formatEuro(seller.shareCapital)}` : seller.legalForm,
    seller.siren ? `SIREN ${seller.siren}` : null,
    seller.rcsCity,
    seller.siret ? `SIRET ${seller.siret}` : null,
    seller.vatNumber ? `TVA ${seller.vatNumber}` : null,
    seller.nafCode ? `APE ${seller.nafCode}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const w = new Writer(pdf, await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold), [
    legal,
    ...(seller.legalMentions ? [seller.legalMentions] : []),
    `Empreinte d'intégrité : ${doc.contentHash ?? ""}`,
  ]);
  const right = A4.w - M;

  // En-tête : vendeur à gauche, document à droite.
  let y = w.y;
  w.text(seller.tradeName || seller.legalName, M, y, 12, { font: w.bold });
  let ly = y - 14;
  for (const l of [...(seller.tradeName ? [seller.legalName] : []), ...seller.address, [seller.email, seller.phone].filter(Boolean).join(" · ")].filter(Boolean)) {
    w.text(l, M, ly, 8.5, { color: MUTED });
    ly -= 11;
  }
  w.text(title, right, y, 15, { font: w.bold, align: "right" });
  let ry = y - 18;
  const meta = [
    `Date d'émission : ${date(doc.issueDate!)}`,
    doc.deliveryDate ? `Date de livraison / d'exécution : ${date(doc.deliveryDate)}` : null,
    doc.type === "invoice" && doc.dueDate ? `Échéance : ${date(doc.dueDate)}` : null,
    doc.type === "quote" && doc.dueDate ? `Valable jusqu'au ${date(doc.dueDate)}` : null,
    doc.type === "credit_note" && sourceNumber ? `Avoir sur la facture n° ${sourceNumber}` : null,
    doc.type === "invoice" && sourceNumber ? `${doc.isDeposit ? "Acompte sur le devis" : "Selon le devis"} n° ${sourceNumber}` : null,
  ].filter((v): v is string => !!v);
  for (const m of meta) {
    w.text(m, right, ry, 8.5, { align: "right" });
    ry -= 11;
  }
  y = Math.min(ly, ry) - 10;
  w.rule(y);

  // Client et livraison.
  y -= 16;
  w.text("CLIENT", M, y, 7, { font: w.bold, color: MUTED });
  if (customer.shippingAddress) w.text("ADRESSE DE LIVRAISON", A4.w / 2, y, 7, { font: w.bold, color: MUTED });
  let cy = y - 12;
  for (const l of [customer.name, ...customer.billingAddress, customer.siren ? `SIREN : ${customer.siren}` : "", customer.vatNumber ? `N° TVA : ${customer.vatNumber}` : "", `Réf. client : ${customer.code}`].filter(Boolean)) {
    w.text(l, M, cy, 9, { font: l === customer.name ? w.bold : w.font });
    cy -= 11.5;
  }
  let sy = y - 12;
  for (const l of customer.shippingAddress ?? []) {
    w.text(l, A4.w / 2, sy, 9);
    sy -= 11.5;
  }
  y = Math.min(cy, sy) - 6;
  if (doc.operationCategory) {
    w.text(`Nature de l'opération : ${CATEGORY[doc.operationCategory]}`, M, y, 8.5, { color: MUTED });
    y -= 14;
  }

  // Tableau des lignes.
  const cols = { qty: right - 290, price: right - 205, disc: right - 145, vat: right - 95, total: right };
  const descWidth = cols.qty - M - 70;
  const header = () => {
    w.rule(y + 4);
    w.text("DÉSIGNATION", M, y - 8, 7, { font: w.bold, color: MUTED });
    w.text("QTÉ", cols.qty, y - 8, 7, { font: w.bold, color: MUTED, align: "right" });
    w.text("PU HT", cols.price, y - 8, 7, { font: w.bold, color: MUTED, align: "right" });
    w.text("REMISE", cols.disc, y - 8, 7, { font: w.bold, color: MUTED, align: "right" });
    w.text("TVA", cols.vat, y - 8, 7, { font: w.bold, color: MUTED, align: "right" });
    w.text("TOTAL HT", cols.total, y - 8, 7, { font: w.bold, color: MUTED, align: "right" });
    y -= 14;
    w.rule(y + 2);
    y -= 10;
  };
  w.y = y;
  header();
  for (const l of lines) {
    const desc = w.wrap(`${l.reference ? `[${l.reference}] ` : ""}${l.description}`, 8.5, descWidth);
    const h = desc.length * 10.5 + 6;
    w.y = y;
    if (w.ensure(h)) {
      y = w.y;
      header();
    }
    desc.forEach((d, i) => w.text(d, M, y - i * 10.5, 8.5));
    w.text(`${dec(l.quantity).toString().replace(".", ",")} ${l.unit}`, cols.qty, y, 8.5, { align: "right" });
    w.text(formatUnitPrice(l.unitPriceExclTax), cols.price, y, 8.5, { align: "right" });
    w.text(dec(l.discountPercent).isZero() ? "—" : formatRate(l.discountPercent), cols.disc, y, 8.5, { align: "right" });
    w.text(formatRate(l.vatRate), cols.vat, y, 8.5, { align: "right" });
    w.text(formatEuro(l.totalExclTax), cols.total, y, 8.5, { align: "right" });
    y -= h;
    w.rule(y + 8);
  }

  // Totaux et mentions.
  const linesTotal = lines.reduce((a, l) => a.plus(l.totalExclTax), dec("0"));
  const globalDiscount = linesTotal.minus(doc.totalExclTax);
  const totals: [string, string, boolean][] = [];
  if (!globalDiscount.isZero()) {
    totals.push(["Total lignes HT", formatEuro(linesTotal), false]);
    totals.push([`Remise globale (${formatRate(doc.globalDiscountPercent)})`, `-${formatEuro(globalDiscount)}`, false]);
  }
  totals.push(["Total HT", formatEuro(doc.totalExclTax), false]);
  for (const v of vat) totals.push([`TVA ${formatRate(v.vatRate)} sur ${formatEuro(v.baseExclTax)}`, formatEuro(v.vatAmount), false]);
  totals.push(["Total TTC", formatEuro(doc.totalInclTax), true]);
  const mentions = [
    ...[...new Set(vat.map((v) => v.vatExemptionReason).filter((v): v is string => !!v))],
    ...(seller.vatOnDebits ? ["Option pour le paiement de la TVA d'après les débits."] : []),
  ];
  w.y = y;
  if (w.ensure(totals.length * 13 + 20)) y = w.y;
  y -= 8;
  let my = y;
  for (const m of mentions) for (const l of w.wrap(m, 8.5, 230)) {
    w.text(l, M, my, 8.5, { font: w.bold });
    my -= 11;
  }
  let ty = y;
  for (const [label, value, strong] of totals) {
    if (strong) {
      w.rule(ty + 9, right - 220);
      ty -= 2;
    }
    w.text(label, right - 220, ty, strong ? 10 : 8.5, { font: strong ? w.bold : w.font, color: strong ? INK : MUTED });
    w.text(value, right, ty, strong ? 10 : 8.5, { font: strong ? w.bold : w.font, align: "right" });
    ty -= strong ? 15 : 12;
  }
  y = Math.min(my, ty) - 8;

  const tail: string[] = [];
  if (doc.notes) tail.push(doc.notes);
  if (doc.type === "invoice") {
    if (seller.iban) tail.push(`Règlement par virement : IBAN ${seller.iban}${seller.bic ? ` — BIC ${seller.bic}` : ""}`);
    if (customer.partyType !== "individual" && seller.latePenaltyText) tail.push(seller.latePenaltyText);
  }
  for (const t of tail) {
    const wrapped = w.wrap(t, 8.5, right - M);
    w.y = y;
    if (w.ensure(wrapped.length * 11 + 6)) y = w.y;
    for (const l of wrapped) {
      w.text(l, M, y, 8.5, { color: MUTED });
      y -= 11;
    }
    y -= 4;
  }
  if (doc.type === "quote") {
    w.y = y;
    if (w.ensure(80)) y = w.y;
    w.page.drawRectangle({ x: A4.w / 2, y: y - 70, width: right - A4.w / 2, height: 64, borderColor: RULE, borderWidth: 0.8, borderDashArray: [3, 3] });
    w.text("Bon pour accord — date et signature du client", A4.w / 2 + 8, y - 18, 8.5, { color: MUTED });
  }
  w.finish();
  return pdf.save();
}
