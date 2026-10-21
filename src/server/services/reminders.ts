import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db, Executor } from "../db/client";
import { companies, paymentReminders, salesDocuments, thirdParties } from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { dec } from "../domain/money";
import { todayInParis } from "../domain/numbering";
import { reminderLetter, type ReminderLevel } from "../domain/reminders";
import { customerSnapshot, sellerSnapshot, type CustomerSnapshot, type SellerSnapshot } from "../domain/sales";
import { getMailTransport } from "../email/transport";
import { appendAuditEvent } from "./audit";
import { exportPdf } from "./einvoice";
import { invoiceBalances } from "./payments";
import { isUuid } from "./third-parties";
import { reminderSchema } from "@/lib/schemas";

/**
 * Relances des factures échues et non réglées : liste à traiter, lettre (modèle à relire),
 * envoi par e-mail si un transport est configuré, et historique en ajout seul.
 */

export async function overdueInvoices(db: Executor, ctx: CompanyContext, now?: Date) {
  assertPermission(ctx, "sales.read");
  const today = todayInParis(now);
  const balances = (await invoiceBalances(db, ctx, {}, now)).filter((b) => dec(b.remaining).greaterThan(0) && b.dueDate && b.dueDate < today);
  if (!balances.length) return [];
  const ids = balances.map((b) => b.id);
  const [docs, reminders] = await Promise.all([
    db
      .select({ id: salesDocuments.id, partyId: thirdParties.id, partyName: thirdParties.name, partyEmail: thirdParties.email, partyType: thirdParties.partyType })
      .from(salesDocuments)
      .innerJoin(thirdParties, and(eq(thirdParties.id, salesDocuments.thirdPartyId), eq(thirdParties.companyId, salesDocuments.companyId)))
      .where(and(eq(salesDocuments.companyId, ctx.companyId), inArray(salesDocuments.id, ids))),
    db.select().from(paymentReminders).where(and(eq(paymentReminders.companyId, ctx.companyId), inArray(paymentReminders.documentId, ids))).orderBy(desc(paymentReminders.sentAt), desc(paymentReminders.level)),
  ]);
  return balances.map((b) => {
    const d = docs.find((x) => x.id === b.id)!;
    const own = reminders.filter((r) => r.documentId === b.id);
    const last = own[0] ?? null;
    const daysLate = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${b.dueDate}T00:00:00Z`)) / 86_400_000);
    return {
      ...b,
      daysLate,
      party: { id: d.partyId, name: d.partyName, email: d.partyEmail, partyType: d.partyType },
      lastReminder: last,
      reminderCount: own.length,
      // Niveau suivant : à partir du plus haut niveau déjà envoyé (indépendant de l'ordre des dates).
      nextLevel: Math.min(3, Math.max(0, ...own.map((r) => r.level)) + 1) as ReminderLevel,
    };
  });
}

async function loadInvoice(db: Executor, ctx: CompanyContext, invoiceId: string, now?: Date) {
  if (!isUuid(invoiceId)) throw notFound("Facture introuvable.");
  const [row] = await db
    .select({ doc: salesDocuments, party: thirdParties, company: companies })
    .from(salesDocuments)
    .innerJoin(thirdParties, and(eq(thirdParties.id, salesDocuments.thirdPartyId), eq(thirdParties.companyId, salesDocuments.companyId)))
    .innerJoin(companies, eq(companies.id, salesDocuments.companyId))
    .where(and(eq(salesDocuments.companyId, ctx.companyId), eq(salesDocuments.id, invoiceId)))
    .limit(1);
  if (!row || row.doc.type !== "invoice" || row.doc.status === "draft") throw notFound("Facture introuvable.");
  const [balance] = await invoiceBalances(db, ctx, { ids: [invoiceId] }, now);
  return { ...row, balance: balance! };
}

/** Lettre de relance d'une facture (niveau choisi), avec les coordonnées actuelles. */
export async function reminderPreview(db: Executor, ctx: CompanyContext, invoiceId: string, level: ReminderLevel, now?: Date) {
  assertPermission(ctx, "sales.read");
  const { doc, party, company, balance } = await loadInvoice(db, ctx, invoiceId, now);
  // Coordonnées du vendeur et du client : celles figées sur la facture, à défaut les actuelles.
  const seller = (doc.sellerSnapshot as SellerSnapshot | null) ?? sellerSnapshot(company);
  const customer = (doc.customerSnapshot as CustomerSnapshot | null) ?? customerSnapshot(party);
  const letter = reminderLetter({
    level,
    seller: { ...seller, iban: company.iban ?? seller.iban, bic: company.bic ?? seller.bic, latePenaltyText: company.latePenaltyText ?? seller.latePenaltyText },
    customer,
    invoice: { number: doc.number!, issueDate: doc.issueDate!, dueDate: doc.dueDate, remaining: balance.remaining },
    today: todayInParis(now),
  });
  return { letter, doc, party, seller, customer, balance };
}

/**
 * Enregistre une relance ; par e-mail, l'envoie si un transport est configuré (facture en
 * pièce jointe). Une facture réglée ou non échue ne se relance pas.
 */
export async function sendReminder(db: Db, ctx: CompanyContext, invoiceId: string, raw: unknown, opts: { now?: Date } = {}) {
  assertPermission(ctx, "sales.write");
  const data = reminderSchema.parse(raw);
  const now = opts.now ?? new Date();
  const { letter, doc, party, balance } = await reminderPreview(db, ctx, invoiceId, data.level as ReminderLevel, now);
  if (!dec(balance.remaining).greaterThan(0)) throw new AppError("VALIDATION", "Cette facture est réglée : aucune relance n'est nécessaire.");
  if (!doc.dueDate || doc.dueDate >= todayInParis(now)) throw new AppError("VALIDATION", "Cette facture n'est pas encore échue.");
  let recipient = data.recipient ?? null;
  let mail: Parameters<NonNullable<ReturnType<typeof getMailTransport>>["send"]>[0] | null = null;
  const transport = data.channel === "email" ? getMailTransport() : null;
  if (data.channel === "email") {
    recipient = recipient ?? party.email;
    if (!recipient) throw new AppError("VALIDATION", "Aucune adresse e-mail pour ce client : indiquez-la, ou choisissez un autre canal.", { recipient: "Adresse requise." });
    if (!transport) {
      throw new AppError("VALIDATION", "L'envoi d'e-mails n'est pas configuré sur cette installation : envoyez la relance depuis votre messagerie, puis enregistrez-la comme « Autre ».");
    }
    const pdf = await exportPdf(db, ctx, doc.id);
    mail = { to: recipient, subject: letter.subject, text: letter.body, attachments: [{ filename: pdf.fileName, contentType: "application/pdf", content: pdf.bytes }] };
  }
  // Envoi dans la transaction : un échec d'envoi n'enregistre aucune relance.
  return db.transaction(async (tx) => {
    const [reminder] = await tx
      .insert(paymentReminders)
      .values({ companyId: ctx.companyId, documentId: doc.id, level: data.level, channel: data.channel, recipient, amountDue: balance.remaining, sentAt: now, createdBy: ctx.userId })
      .returning();
    const messageId = mail && transport ? (await transport.send(mail)).messageId : null;
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "sales_document.reminder_sent",
      entityType: "sales_document",
      entityId: doc.id,
      payload: { number: doc.number, level: data.level, channel: data.channel, recipient, amountDue: balance.remaining, messageId },
    });
    return { reminder: reminder!, sent: !!messageId };
  });
}

export async function remindersOf(db: Executor, ctx: CompanyContext, invoiceId: string) {
  assertPermission(ctx, "sales.read");
  return db.select().from(paymentReminders).where(and(eq(paymentReminders.companyId, ctx.companyId), eq(paymentReminders.documentId, invoiceId))).orderBy(desc(paymentReminders.sentAt), desc(paymentReminders.level));
}
