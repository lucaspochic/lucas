import type { Executor } from "../db/client";
import { AppError } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { buildCii } from "../domain/cii";
import type { CustomerSnapshot, SellerSnapshot } from "../domain/sales";
import { getSalesDocument } from "./sales";
import { renderSalesDocumentPdf } from "../pdf/sales-pdf";

/**
 * Données structurées d'une facture ou d'un avoir émis (format CII, norme EN 16931).
 * Préparation à la facturation électronique : la transmission passera par la plateforme
 * agréée retenue (dépendance externe, non branchée).
 */
export async function exportCii(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "sales.read");
  const { doc, lines, vat, source } = await getSalesDocument(db, ctx, id);
  if (doc.status === "draft" || doc.type === "quote") throw new AppError("VALIDATION", "Seules les factures et les avoirs émis s'exportent au format CII.");
  let sourceIssueDate: string | null = null;
  if (doc.type === "credit_note" && source) {
    sourceIssueDate = (await getSalesDocument(db, ctx, source.id)).doc.issueDate;
  }
  const xml = buildCii({
    type: doc.type,
    isDeposit: doc.isDeposit,
    number: doc.number!,
    issueDate: doc.issueDate!,
    dueDate: doc.dueDate,
    deliveryDate: doc.deliveryDate,
    currency: doc.currency,
    globalDiscountPercent: doc.globalDiscountPercent,
    totalExclTax: doc.totalExclTax,
    totalVat: doc.totalVat,
    totalInclTax: doc.totalInclTax,
    seller: doc.sellerSnapshot as SellerSnapshot,
    customer: doc.customerSnapshot as CustomerSnapshot,
    lines: lines.map((l) => ({ ...l, noGlobalDiscount: !!l.deductedDocumentId })),
    vat,
    sourceNumber: source?.number ?? null,
    sourceIssueDate,
  });
  return { fileName: `${doc.number}.xml`, xml };
}

/** PDF (consultation, impression, envoi) d'un document de vente émis. */
export async function exportPdf(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "sales.read");
  const { doc, lines, vat, source } = await getSalesDocument(db, ctx, id);
  if (doc.status === "draft") throw new AppError("VALIDATION", "Un brouillon n'a pas de version PDF : émettez-le d'abord.");
  const bytes = await renderSalesDocumentPdf({ doc, lines, vat, sourceNumber: source?.number ?? null });
  return { fileName: `${doc.number}.pdf`, bytes };
}
