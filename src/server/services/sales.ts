import { createHash } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db, Executor, Tx } from "../db/client";
import {
  companies,
  products,
  salesDocumentLines,
  salesDocuments,
  salesDocumentVat,
  thirdParties,
  vatRates,
  type SalesDocument,
  type SalesDocumentLine,
} from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { canonicalJson } from "../security/canonical-json";
import { computeDocumentTotals } from "../domain/document-totals";
import { dec } from "../domain/money";
import { fiscalYearOf, todayInParis, type DocumentType } from "../domain/numbering";
import {
  addDays,
  checkBeforeIssue,
  customerSnapshot,
  operationCategoryOf,
  QUOTE_VALIDITY_DAYS,
  sellerSnapshot,
} from "../domain/sales";
import { appendAuditEvent } from "./audit";
import { allocateDocumentNumber } from "./sequences";
import { postSalesDocument } from "./accounting";
import { likePattern, PAGE_SIZE, type ListParams } from "./listing";
import { isUuid } from "./third-parties";
import { salesDraftSchema, type SalesDraftData } from "@/lib/schemas";

/**
 * Cycle des documents de vente : brouillon → émission (numéro, figement) → suites
 * (acceptation/refus d'un devis, conversion en facture, avoir sur facture).
 *
 * Garanties :
 *  - les montants sont toujours recalculés ici à partir des lignes (jamais repris du client) ;
 *  - un document émis n'est plus modifiable : triggers PostgreSQL (migration 0004) +
 *    empreinte SHA-256 du contenu reprise dans le journal d'audit chaîné ;
 *  - la date d'émission est la date du jour (Europe/Paris) : l'ordre des numéros suit
 *    l'ordre chronologique ;
 *  - le cumul des avoirs d'une facture ne peut pas dépasser son montant TTC.
 */

export type EditableType = "quote" | "invoice";

const NUMBERING: Record<SalesDocument["type"], { seq: DocumentType; prefix: (c: typeof companies.$inferSelect) => string }> = {
  quote: { seq: "quote", prefix: (c) => c.quotePrefix },
  invoice: { seq: "invoice", prefix: (c) => c.invoicePrefix },
  credit_note: { seq: "credit_note", prefix: (c) => c.creditNotePrefix },
};

function scoped(ctx: CompanyContext, id: string) {
  if (!isUuid(id)) throw notFound("Document introuvable.");
  return and(eq(salesDocuments.companyId, ctx.companyId), eq(salesDocuments.id, id));
}

async function lockDocument(tx: Tx, ctx: CompanyContext, id: string): Promise<SalesDocument> {
  const [doc] = await tx.select().from(salesDocuments).where(scoped(ctx, id)).for("update").limit(1);
  if (!doc) throw notFound("Document introuvable.");
  return doc;
}

function assertDraft(doc: SalesDocument) {
  if (doc.status !== "draft") {
    throw new AppError("IMMUTABLE", "Ce document est émis : il ne peut plus être modifié. Pour une facture, établissez un avoir.");
  }
}

// ─── Lecture ────────────────────────────────────────────────────────────────

export const SALES_SORTS = ["date", "numero", "montant", "creation"] as const;
export type SalesSort = (typeof SALES_SORTS)[number];

export interface SalesFilters extends Omit<ListParams<SalesSort>, "archived"> {
  type: SalesDocument["type"];
  status?: SalesDocument["status"];
}

export async function listSalesDocuments(db: Executor, ctx: CompanyContext, f: SalesFilters) {
  assertPermission(ctx, "sales.read");
  const conditions: SQL[] = [eq(salesDocuments.companyId, ctx.companyId), eq(salesDocuments.type, f.type)];
  if (f.status) conditions.push(eq(salesDocuments.status, f.status));
  if (f.q) {
    const p = likePattern(f.q);
    conditions.push(or(ilike(salesDocuments.number, p), ilike(thirdParties.name, p), ilike(thirdParties.code, p))!);
  }
  const where = and(...conditions);
  const column = {
    date: sql`coalesce(${salesDocuments.issueDate}, to_char(${salesDocuments.createdAt}, 'YYYY-MM-DD'))`,
    numero: salesDocuments.number,
    montant: salesDocuments.totalInclTax,
    creation: salesDocuments.createdAt,
  }[f.sort];
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({ doc: salesDocuments, partyName: thirdParties.name, partyCode: thirdParties.code })
      .from(salesDocuments)
      .innerJoin(thirdParties, and(eq(thirdParties.id, salesDocuments.thirdPartyId), eq(thirdParties.companyId, salesDocuments.companyId)))
      .where(where)
      .orderBy(f.dir === "desc" ? desc(column) : asc(column), desc(salesDocuments.createdAt))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(salesDocuments)
      .innerJoin(thirdParties, and(eq(thirdParties.id, salesDocuments.thirdPartyId), eq(thirdParties.companyId, salesDocuments.companyId)))
      .where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r.doc, partyName: r.partyName, partyCode: r.partyCode })), total, pageSize: PAGE_SIZE };
}

export async function getSalesDocument(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "sales.read");
  const [doc] = await db.select().from(salesDocuments).where(scoped(ctx, id)).limit(1);
  if (!doc) throw notFound("Document introuvable.");
  const [lines, vat, [party], related] = await Promise.all([
    db.select().from(salesDocumentLines).where(eq(salesDocumentLines.documentId, doc.id)).orderBy(asc(salesDocumentLines.position)),
    db.select().from(salesDocumentVat).where(eq(salesDocumentVat.documentId, doc.id)).orderBy(desc(salesDocumentVat.vatRate)),
    db
      .select()
      .from(thirdParties)
      .where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.id, doc.thirdPartyId)))
      .limit(1),
    // Documents liés : origine, et documents issus de celui-ci (factures d'un devis, avoirs d'une facture).
    db
      .select({
        id: salesDocuments.id,
        type: salesDocuments.type,
        status: salesDocuments.status,
        number: salesDocuments.number,
        totalInclTax: salesDocuments.totalInclTax,
        sourceDocumentId: salesDocuments.sourceDocumentId,
      })
      .from(salesDocuments)
      .where(
        and(
          eq(salesDocuments.companyId, ctx.companyId),
          or(
            eq(salesDocuments.sourceDocumentId, doc.id),
            doc.sourceDocumentId ? eq(salesDocuments.id, doc.sourceDocumentId) : sql`false`,
          ),
        ),
      ),
  ]);
  return {
    doc,
    lines,
    vat,
    party: party!,
    source: related.find((r) => r.id === doc.sourceDocumentId) ?? null,
    derived: related.filter((r) => r.sourceDocumentId === doc.id),
  };
}

// ─── Brouillons ─────────────────────────────────────────────────────────────

interface ResolvedLine {
  productId: string | null;
  reference: string | null;
  description: string;
  kind: "good" | "service";
  quantity: string;
  unit: string;
  unitPriceExclTax: string;
  discountPercent: string;
  vatRate: string;
  vatExemptionReason: string | null;
}

function toResolved(l: SalesDocumentLine): ResolvedLine {
  return {
    productId: l.productId,
    reference: l.reference,
    description: l.description,
    kind: l.kind,
    quantity: l.quantity,
    unit: l.unit,
    unitPriceExclTax: l.unitPriceExclTax,
    discountPercent: l.discountPercent,
    vatRate: l.vatRate,
    vatExemptionReason: l.vatExemptionReason,
  };
}

/** Remplace les identifiants de taux par les taux de l'entreprise et vérifie les articles. */
async function resolveLines(tx: Executor, ctx: CompanyContext, data: SalesDraftData): Promise<ResolvedLine[]> {
  const rateIds = [...new Set(data.lines.map((l) => l.vatRateId))];
  const rates = await tx
    .select()
    .from(vatRates)
    .where(and(eq(vatRates.companyId, ctx.companyId), inArray(vatRates.id, rateIds)));
  const productIds = [...new Set(data.lines.map((l) => l.productId).filter((p): p is string => !!p))];
  const knownProducts = productIds.length
    ? await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.companyId, ctx.companyId), inArray(products.id, productIds)))
    : [];
  return data.lines.map((l, i) => {
    const rate = rates.find((r) => r.id === l.vatRateId);
    if (!rate) throw new AppError("VALIDATION", `Ligne ${i + 1} : taux de TVA inconnu.`);
    if (l.productId && !knownProducts.some((p) => p.id === l.productId)) {
      throw new AppError("VALIDATION", `Ligne ${i + 1} : article inconnu.`);
    }
    return {
      productId: l.productId ?? null,
      reference: l.reference ?? null,
      description: l.description,
      kind: l.kind,
      quantity: dec(l.quantity).toFixed(3),
      unit: l.unit,
      unitPriceExclTax: dec(l.unitPriceExclTax).toFixed(4),
      discountPercent: dec(l.discountPercent).toFixed(2),
      vatRate: rate.rate,
      vatExemptionReason: dec(rate.rate).isZero() ? rate.exemptionReason : null,
    };
  });
}

function totalsOf(lines: readonly Pick<ResolvedLine, "quantity" | "unitPriceExclTax" | "discountPercent" | "vatRate" | "vatExemptionReason">[], globalDiscountPercent: string) {
  return computeDocumentTotals({
    lines: lines.map((l) => ({
      quantity: l.quantity,
      unitPriceExclTax: l.unitPriceExclTax,
      discountPercent: l.discountPercent,
      vatRate: l.vatRate,
      vatExemptionReason: l.vatExemptionReason ?? undefined,
    })),
    globalDiscountPercent,
  });
}

/** Écrit les lignes, la ventilation de TVA et les totaux d'un brouillon (tout est recalculé). */
async function writeDraftContent(
  tx: Tx,
  ctx: CompanyContext,
  documentId: string,
  lines: ResolvedLine[],
  globalDiscountPercent: string,
) {
  const totals = totalsOf(lines, globalDiscountPercent);
  await tx.delete(salesDocumentLines).where(eq(salesDocumentLines.documentId, documentId));
  await tx.delete(salesDocumentVat).where(eq(salesDocumentVat.documentId, documentId));
  await tx.insert(salesDocumentLines).values(
    lines.map((l, i) => ({
      ...l,
      companyId: ctx.companyId,
      documentId,
      position: i + 1,
      totalExclTax: totals.lines[i]!.totalExclTaxBeforeGlobalDiscount,
    })),
  );
  await tx.insert(salesDocumentVat).values(
    totals.vatBreakdown.map((v) => ({
      companyId: ctx.companyId,
      documentId,
      vatRate: v.vatRate,
      vatExemptionReason: v.vatExemptionReason,
      baseExclTax: v.baseExclTax,
      vatAmount: v.vatAmount,
    })),
  );
  await tx
    .update(salesDocuments)
    .set({
      globalDiscountPercent: dec(globalDiscountPercent).toFixed(2),
      totalExclTax: totals.totalExclTax,
      totalVat: totals.totalVat,
      totalInclTax: totals.totalInclTax,
      operationCategory: operationCategoryOf(lines.map((l) => l.kind)),
      updatedAt: new Date(),
    })
    .where(scoped(ctx, documentId));
  return totals;
}

async function assertCustomer(tx: Executor, ctx: CompanyContext, thirdPartyId: string) {
  const [party] = await tx
    .select()
    .from(thirdParties)
    .where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.id, thirdPartyId)))
    .limit(1);
  if (!party) throw new AppError("VALIDATION", "Client inconnu.", { thirdPartyId: "Client inconnu." });
  if (!party.isCustomer) throw new AppError("VALIDATION", "Ce tiers n'est pas un client.", { thirdPartyId: "Pas un client." });
  if (party.archivedAt) throw new AppError("VALIDATION", "Ce client est archivé.", { thirdPartyId: "Client archivé." });
  return party;
}

export async function createDraft(db: Db, ctx: CompanyContext, type: EditableType, raw: unknown) {
  assertPermission(ctx, "sales.write");
  if (type !== "quote" && type !== "invoice") throw new AppError("VALIDATION", "Type de document invalide.");
  const data = salesDraftSchema.parse(raw);
  return db.transaction(async (tx) => {
    await assertCustomer(tx, ctx, data.thirdPartyId);
    const lines = await resolveLines(tx, ctx, data);
    const [doc] = await tx
      .insert(salesDocuments)
      .values({
        companyId: ctx.companyId,
        type,
        thirdPartyId: data.thirdPartyId,
        deliveryDate: data.deliveryDate ?? null,
        notes: data.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    const totals = await writeDraftContent(tx, ctx, doc!.id, lines, data.globalDiscountPercent);
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "sales_document.draft_created",
      entityType: "sales_document",
      entityId: doc!.id,
      payload: { type, totalInclTax: totals.totalInclTax },
    });
    return doc!;
  });
}

export async function updateDraft(db: Db, ctx: CompanyContext, id: string, raw: unknown) {
  assertPermission(ctx, "sales.write");
  const data = salesDraftSchema.parse(raw);
  return db.transaction(async (tx) => {
    const doc = await lockDocument(tx, ctx, id);
    assertDraft(doc);
    if (doc.type === "credit_note" && data.thirdPartyId !== doc.thirdPartyId) {
      throw new AppError("VALIDATION", "Le client d'un avoir est celui de la facture d'origine.");
    }
    await assertCustomer(tx, ctx, data.thirdPartyId);
    const lines = await resolveLines(tx, ctx, data);
    await tx
      .update(salesDocuments)
      .set({ thirdPartyId: data.thirdPartyId, deliveryDate: data.deliveryDate ?? null, notes: data.notes ?? null })
      .where(scoped(ctx, id));
    const totals = await writeDraftContent(tx, ctx, id, lines, data.globalDiscountPercent);
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "sales_document.draft_updated",
      entityType: "sales_document",
      entityId: id,
      payload: { type: doc.type, totalInclTax: totals.totalInclTax },
    });
  });
}

/** Seuls les brouillons (sans numéro) peuvent être supprimés. */
export async function deleteDraft(db: Db, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "sales.write");
  await db.transaction(async (tx) => {
    const doc = await lockDocument(tx, ctx, id);
    assertDraft(doc);
    await tx.delete(salesDocuments).where(scoped(ctx, id));
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "sales_document.draft_deleted",
      entityType: "sales_document",
      entityId: id,
      payload: { type: doc.type, totalInclTax: doc.totalInclTax },
    });
  });
}

// ─── Émission ───────────────────────────────────────────────────────────────

/** Contenu couvert par l'empreinte d'un document émis (relu depuis la base : formats stables). */
function hashContent(doc: SalesDocument, lines: SalesDocumentLine[], vat: (typeof salesDocumentVat.$inferSelect)[], sourceNumber: string | null) {
  return {
    type: doc.type,
    number: doc.number,
    issueDate: doc.issueDate,
    dueDate: doc.dueDate,
    deliveryDate: doc.deliveryDate,
    operationCategory: doc.operationCategory,
    currency: doc.currency,
    sourceNumber,
    seller: doc.sellerSnapshot,
    customer: doc.customerSnapshot,
    globalDiscountPercent: doc.globalDiscountPercent,
    totals: { excl: doc.totalExclTax, vat: doc.totalVat, incl: doc.totalInclTax },
    lines: lines.map((l) => [
      l.position, l.reference, l.description, l.kind, l.quantity, l.unit, l.unitPriceExclTax, l.discountPercent, l.vatRate,
      l.vatExemptionReason, l.totalExclTax,
    ]),
    vat: vat
      .map((v) => [v.vatRate, v.vatExemptionReason, v.baseExclTax, v.vatAmount])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))),
  };
}

export function sha256(content: unknown): string {
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export interface IssueOptions {
  /** Pour les tests uniquement : date du jour simulée. */
  now?: Date;
  /** Les avertissements ont été vus et acceptés par l'utilisateur. */
  acceptWarnings?: boolean;
}

export async function issueDocument(db: Db, ctx: CompanyContext, id: string, opts: IssueOptions = {}) {
  assertPermission(ctx, "sales.issue");
  return db.transaction(async (tx) => {
    const doc = await lockDocument(tx, ctx, id);
    assertDraft(doc);
    const [company] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
    const [party] = await tx
      .select()
      .from(thirdParties)
      .where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.id, doc.thirdPartyId)))
      .limit(1);
    const lines = await tx
      .select()
      .from(salesDocumentLines)
      .where(eq(salesDocumentLines.documentId, id))
      .orderBy(asc(salesDocumentLines.position));

    const check = checkBeforeIssue(doc.type, company!, party!, lines.length);
    if (check.blocking.length > 0) {
      throw new AppError("VALIDATION", `Émission impossible : ${check.blocking.join(" ")}`);
    }
    if (check.warnings.length > 0 && !opts.acceptWarnings) {
      throw new AppError("CONFLICT", `À vérifier avant émission : ${check.warnings.join(" ")}`);
    }

    // Recalcul complet à partir des lignes enregistrées.
    const resolved = lines.map(toResolved);
    const totals = await writeDraftContent(tx, ctx, id, resolved, doc.globalDiscountPercent);

    let sourceNumber: string | null = null;
    if (doc.type === "credit_note") {
      // Verrou sur la facture d'origine : sérialise les avoirs concurrents sur la même facture.
      const [invoice] = await tx
        .select()
        .from(salesDocuments)
        .where(and(eq(salesDocuments.companyId, ctx.companyId), eq(salesDocuments.id, doc.sourceDocumentId!)))
        .for("update")
        .limit(1);
      if (!invoice || invoice.type !== "invoice" || invoice.status === "draft") {
        throw new AppError("VALIDATION", "L'avoir doit se rapporter à une facture émise.");
      }
      const [{ credited } = { credited: "0" }] = await tx
        .select({ credited: sql<string>`coalesce(sum(${salesDocuments.totalInclTax}), 0)::text` })
        .from(salesDocuments)
        .where(
          and(
            eq(salesDocuments.companyId, ctx.companyId),
            eq(salesDocuments.sourceDocumentId, invoice.id),
            eq(salesDocuments.type, "credit_note"),
            ne(salesDocuments.status, "draft"),
          ),
        );
      const remaining = dec(invoice.totalInclTax).minus(credited);
      if (dec(totals.totalInclTax).greaterThan(remaining)) {
        throw new AppError(
          "VALIDATION",
          `Le montant de l'avoir (${totals.totalInclTax} €) dépasse le montant restant à créditer sur la facture ${invoice.number} (${remaining.toFixed(2)} €).`,
        );
      }
      sourceNumber = invoice.number;
    }

    const issueDate = todayInParis(opts.now);
    const fiscalYear = fiscalYearOf(issueDate, company!.fiscalYearStartMonth);
    const numbering = NUMBERING[doc.type];
    const { number } = await allocateDocumentNumber(tx, {
      companyId: ctx.companyId,
      documentType: numbering.seq,
      fiscalYear,
      prefix: numbering.prefix(company!),
    });
    const terms = party!.paymentTermsDays ?? company!.paymentTermsDays;
    const dueDate =
      doc.type === "invoice" ? addDays(issueDate, terms) : doc.type === "quote" ? addDays(issueDate, QUOTE_VALIDITY_DAYS) : null;

    const [prepared] = await tx
      .update(salesDocuments)
      .set({
        sellerSnapshot: sellerSnapshot(company!),
        customerSnapshot: customerSnapshot(party!),
        issueDate,
        dueDate,
        fiscalYear,
      })
      .where(scoped(ctx, id))
      .returning();
    const finalLines = await tx
      .select()
      .from(salesDocumentLines)
      .where(eq(salesDocumentLines.documentId, id))
      .orderBy(asc(salesDocumentLines.position));
    const finalVat = await tx.select().from(salesDocumentVat).where(eq(salesDocumentVat.documentId, id));
    const contentHash = sha256(hashContent({ ...prepared!, number }, finalLines, finalVat, sourceNumber));

    const [issued] = await tx
      .update(salesDocuments)
      .set({ status: "issued", number, contentHash, issuedAt: new Date(), issuedBy: ctx.userId, updatedAt: new Date() })
      .where(scoped(ctx, id))
      .returning();
    await postSalesDocument(tx, company!, { doc: issued!, lines: finalLines, party: party!, sourceNumber });
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "sales_document.issued",
      entityType: "sales_document",
      entityId: id,
      payload: {
        type: doc.type,
        number,
        issueDate,
        customer: party!.code,
        totalExclTax: totals.totalExclTax,
        totalVat: totals.totalVat,
        totalInclTax: totals.totalInclTax,
        sourceNumber,
        contentHash,
      },
    });
    return issued!;
  });
}

/** Contrôle d'intégrité : recalcule l'empreinte d'un document émis. */
export async function verifyDocumentIntegrity(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "sales.read");
  const { doc, lines, vat, source } = await getSalesDocument(db, ctx, id);
  if (doc.status === "draft") return { valid: true, draft: true };
  const recomputed = sha256(hashContent(doc, lines, vat, source?.number ?? null));
  return { valid: recomputed === doc.contentHash, draft: false };
}

// ─── Suites d'un document émis ──────────────────────────────────────────────

export async function respondToQuote(db: Db, ctx: CompanyContext, id: string, response: "accepted" | "refused") {
  assertPermission(ctx, "sales.write");
  return db.transaction(async (tx) => {
    const doc = await lockDocument(tx, ctx, id);
    if (doc.type !== "quote" || doc.status !== "issued") {
      throw new AppError("VALIDATION", "Seul un devis émis, sans réponse, peut être accepté ou refusé.");
    }
    await tx
      .update(salesDocuments)
      .set({ status: response, respondedAt: new Date(), updatedAt: new Date() })
      .where(scoped(ctx, id));
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: response === "accepted" ? "sales_document.quote_accepted" : "sales_document.quote_refused",
      entityType: "sales_document",
      entityId: id,
      payload: { number: doc.number },
    });
  });
}

/** Copie les lignes d'un document émis dans un nouveau brouillon (facture d'un devis, avoir d'une facture). */
async function deriveDraft(tx: Tx, ctx: CompanyContext, source: SalesDocument, type: "invoice" | "credit_note") {
  const lines = await tx
    .select()
    .from(salesDocumentLines)
    .where(eq(salesDocumentLines.documentId, source.id))
    .orderBy(asc(salesDocumentLines.position));
  const [draft] = await tx
    .insert(salesDocuments)
    .values({
      companyId: ctx.companyId,
      type,
      thirdPartyId: source.thirdPartyId,
      sourceDocumentId: source.id,
      deliveryDate: source.deliveryDate,
      createdBy: ctx.userId,
    })
    .returning();
  await writeDraftContent(tx, ctx, draft!.id, lines.map(toResolved), source.globalDiscountPercent);
  await appendAuditEvent(tx, {
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    action: type === "invoice" ? "sales_document.invoice_from_quote" : "sales_document.credit_note_drafted",
    entityType: "sales_document",
    entityId: draft!.id,
    payload: { sourceNumber: source.number },
  });
  return draft!;
}

export async function convertQuoteToInvoice(db: Db, ctx: CompanyContext, quoteId: string) {
  assertPermission(ctx, "sales.write");
  return db.transaction(async (tx) => {
    const quote = await lockDocument(tx, ctx, quoteId);
    if (quote.type !== "quote" || !["issued", "accepted"].includes(quote.status)) {
      throw new AppError("VALIDATION", "Seul un devis émis ou accepté peut être transformé en facture.");
    }
    const [existing] = await tx
      .select({ id: salesDocuments.id })
      .from(salesDocuments)
      .where(and(eq(salesDocuments.companyId, ctx.companyId), eq(salesDocuments.sourceDocumentId, quote.id), eq(salesDocuments.type, "invoice")))
      .limit(1);
    if (existing) return { id: existing.id, created: false };
    const draft = await deriveDraft(tx, ctx, quote, "invoice");
    return { id: draft.id, created: true };
  });
}

export async function createCreditNoteDraft(db: Db, ctx: CompanyContext, invoiceId: string) {
  assertPermission(ctx, "sales.write");
  return db.transaction(async (tx) => {
    const invoice = await lockDocument(tx, ctx, invoiceId);
    if (invoice.type !== "invoice" || invoice.status === "draft") {
      throw new AppError("VALIDATION", "Un avoir ne peut être établi que sur une facture émise.");
    }
    return deriveDraft(tx, ctx, invoice, "credit_note");
  });
}

/** Clients actifs proposés dans les formulaires de vente. */
export async function listCustomerOptions(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "sales.read");
  return db
    .select({ id: thirdParties.id, code: thirdParties.code, name: thirdParties.name, partyType: thirdParties.partyType })
    .from(thirdParties)
    .where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.isCustomer, true), sql`${thirdParties.archivedAt} is null`))
    .orderBy(asc(sql`lower(${thirdParties.name})`))
    .limit(1000);
}

/** Articles actifs proposés dans l'éditeur de lignes. */
export async function listProductOptions(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "sales.read");
  return db
    .select({
      id: products.id,
      reference: products.reference,
      name: products.name,
      description: products.description,
      kind: products.kind,
      unit: products.unit,
      unitPriceExclTax: products.unitPriceExclTax,
      vatRateId: products.vatRateId,
    })
    .from(products)
    .where(and(eq(products.companyId, ctx.companyId), sql`${products.archivedAt} is null`))
    .orderBy(asc(products.reference))
    .limit(2000);
}
