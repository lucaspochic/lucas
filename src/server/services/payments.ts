import { createHash } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db, Executor, Tx } from "../db/client";
import {
  companies,
  idempotencyKeys,
  paymentAllocations,
  payments,
  salesDocuments,
  thirdParties,
  type Payment,
} from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { canonicalJson } from "../security/canonical-json";
import { D, dec, type Dec } from "../domain/money";
import { fiscalYearOf, todayInParis } from "../domain/numbering";
import { GENESIS_HASH, appendAuditEvent } from "./audit";
import { allocateDocumentNumber } from "./sequences";
import { likePattern, PAGE_SIZE, type ListParams } from "./listing";
import { isUuid } from "./third-parties";
import { resolveTreasuryAccount } from "./treasury";
import { loadCompany, postCustomerPayment } from "./accounting";
import { paymentSchema, reversalSchema, type PaymentData } from "@/lib/schemas";

/**
 * Règlements clients — en ajout seul, chaînés, idempotents.
 *
 *  - Un règlement enregistré n'est jamais modifié ni supprimé (triggers, migration 0006).
 *    Une erreur se corrige par une contre-passation (montant opposé, motif obligatoire).
 *  - Chaque requête porte une clé d'idempotence : un double envoi renvoie le premier résultat.
 *  - Les imputations sur facture sont contrôlées sous verrou de la facture : jamais plus
 *    que le reste à payer (encaissement), jamais plus que le trop-perçu (remboursement).
 *  - Chaque règlement est chaîné au précédent de l'entreprise (empreinte SHA-256).
 *
 * Reste à payer d'une facture = TTC − avoirs émis sur la facture − montant réglé.
 */

export type InvoiceStatus = "paid" | "partial" | "unpaid" | "overdue" | "overpaid";

export interface InvoiceBalance {
  id: string;
  number: string;
  issueDate: string;
  dueDate: string | null;
  totalInclTax: string;
  credited: string;
  netDue: string;
  paid: string;
  remaining: string;
  status: InvoiceStatus;
}

export function invoiceStatus(netDue: Dec, paid: Dec, dueDate: string | null, today: string): InvoiceStatus {
  const remaining = netDue.minus(paid);
  if (remaining.isNegative()) return "overpaid";
  if (remaining.isZero()) return "paid";
  if (dueDate && dueDate < today) return "overdue";
  return paid.isZero() ? "unpaid" : "partial";
}

/** Soldes des factures émises (filtrées par identifiants ou par client). */
export async function invoiceBalances(
  db: Executor,
  ctx: CompanyContext,
  filter: { ids?: string[]; thirdPartyId?: string },
  now?: Date,
): Promise<InvoiceBalance[]> {
  const credit = db
    .select({
      sourceId: salesDocuments.sourceDocumentId,
      credited: sql<string>`sum(${salesDocuments.totalInclTax})`.as("credited"),
    })
    .from(salesDocuments)
    .where(and(eq(salesDocuments.companyId, ctx.companyId), eq(salesDocuments.type, "credit_note"), ne(salesDocuments.status, "draft")))
    .groupBy(salesDocuments.sourceDocumentId)
    .as("credit");
  const conditions: SQL[] = [
    eq(salesDocuments.companyId, ctx.companyId),
    eq(salesDocuments.type, "invoice"),
    ne(salesDocuments.status, "draft"),
  ];
  if (filter.ids) conditions.push(filter.ids.length ? inArray(salesDocuments.id, filter.ids) : sql`false`);
  if (filter.thirdPartyId) conditions.push(eq(salesDocuments.thirdPartyId, filter.thirdPartyId));
  const rows = await db
    .select({
      id: salesDocuments.id,
      number: salesDocuments.number,
      issueDate: salesDocuments.issueDate,
      dueDate: salesDocuments.dueDate,
      totalInclTax: salesDocuments.totalInclTax,
      amountPaid: salesDocuments.amountPaid,
      credited: sql<string>`coalesce(${credit.credited}, 0)::text`,
    })
    .from(salesDocuments)
    .leftJoin(credit, eq(credit.sourceId, salesDocuments.id))
    .where(and(...conditions))
    .orderBy(asc(salesDocuments.issueDate), asc(salesDocuments.number));
  const today = todayInParis(now);
  return rows.map((r) => {
    const netDue = dec(r.totalInclTax).minus(dec(r.credited));
    const paid = dec(r.amountPaid);
    return {
      id: r.id,
      number: r.number!,
      issueDate: r.issueDate!,
      dueDate: r.dueDate,
      totalInclTax: r.totalInclTax,
      credited: dec(r.credited).toFixed(2),
      netDue: netDue.toFixed(2),
      paid: paid.toFixed(2),
      remaining: netDue.minus(paid).toFixed(2),
      status: invoiceStatus(netDue, paid, r.dueDate, today),
    };
  });
}

// ─── Chaînage ───────────────────────────────────────────────────────────────

function paymentHashContent(p: Omit<Payment, "hash" | "id">, allocations: { documentId: string; amount: string }[]) {
  return {
    companyId: p.companyId,
    chainSeq: p.chainSeq,
    number: p.number,
    kind: p.kind,
    recordedAt: p.recordedAt.toISOString(),
    paymentDate: p.paymentDate,
    thirdPartyId: p.thirdPartyId,
    partyType: p.partyTypeSnapshot,
    method: p.method,
    amount: p.amount,
    reference: p.reference,
    reversesPaymentId: p.reversesPaymentId,
    reason: p.reason,
    // Absent (undefined) pour les règlements antérieurs au compte de trésorerie : empreinte inchangée.
    bankAccountId: p.bankAccountId ?? undefined,
    allocations: [...allocations].sort((a, b) => a.documentId.localeCompare(b.documentId)).map((a) => [a.documentId, a.amount]),
  };
}

const sha256 = (prev: string, content: unknown) => createHash("sha256").update(prev).update("\n").update(canonicalJson(content)).digest("hex");

export interface PaymentChainVerification {
  valid: boolean;
  checked: number;
  headHash?: string;
  firstError?: { number: string; reason: string };
}

export async function verifyPaymentChain(db: Executor, companyId: string): Promise<PaymentChainVerification> {
  const rows = await db.select().from(payments).where(eq(payments.companyId, companyId)).orderBy(asc(payments.chainSeq));
  const allocs = rows.length
    ? await db
        .select()
        .from(paymentAllocations)
        .where(and(eq(paymentAllocations.companyId, companyId)))
    : [];
  let prev = GENESIS_HASH;
  let seq = 1;
  for (const p of rows) {
    const fail = (reason: string) => ({ valid: false, checked: seq - 1, firstError: { number: p.number, reason } });
    if (p.chainSeq !== seq) return fail("Rupture de séquence (règlement supprimé ou inséré).");
    if (p.prevHash !== prev) return fail("Chaînage incohérent.");
    const mine = allocs.filter((a) => a.paymentId === p.id).map((a) => ({ documentId: a.documentId, amount: a.amount }));
    if (sha256(prev, paymentHashContent(p, mine)) !== p.hash) return fail("Contenu modifié après enregistrement.");
    prev = p.hash;
    seq++;
  }
  return { valid: true, checked: rows.length, headHash: prev };
}

// ─── Enregistrement ─────────────────────────────────────────────────────────

interface Idempotent<T> {
  result: T;
  replayed: boolean;
}

/** Réserve la clé d'idempotence dans la transaction ; renvoie le résultat déjà produit en cas de rejeu. */
async function claimIdempotencyKey(tx: Tx, ctx: CompanyContext, key: string, operation: string, request: unknown) {
  const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex");
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({ companyId: ctx.companyId, key, operation, requestHash })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length > 0) return null;
  const [existing] = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.companyId, ctx.companyId), eq(idempotencyKeys.key, key)))
    .limit(1);
  if (!existing || existing.operation !== operation || existing.requestHash !== requestHash) {
    throw new AppError("CONFLICT", "Cette demande a déjà été utilisée pour une autre opération. Rechargez la page.");
  }
  return existing.response as { paymentId: string };
}

async function insertPayment(
  tx: Tx,
  ctx: CompanyContext,
  input: Omit<Payment, "id" | "companyId" | "number" | "fiscalYear" | "recordedAt" | "chainSeq" | "prevHash" | "hash" | "createdBy">,
  allocations: { documentId: string; amount: string }[],
  now: Date,
) {
  const [company] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  const today = todayInParis(now);
  const fiscalYear = fiscalYearOf(today, company!.fiscalYearStartMonth);
  const { number } = await allocateDocumentNumber(tx, { companyId: ctx.companyId, documentType: "payment", fiscalYear, prefix: "RG" });

  // Tête de chaîne verrouillée : sérialise les enregistrements concurrents.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"payments:" + ctx.companyId}))`);
  const [last] = await tx
    .select({ chainSeq: payments.chainSeq, hash: payments.hash })
    .from(payments)
    .where(eq(payments.companyId, ctx.companyId))
    .orderBy(desc(payments.chainSeq))
    .limit(1);
  const prevHash = last?.hash ?? GENESIS_HASH;
  const row = {
    ...input,
    companyId: ctx.companyId,
    number,
    fiscalYear,
    recordedAt: now,
    chainSeq: (last?.chainSeq ?? 0) + 1,
    prevHash,
    createdBy: ctx.userId,
  };
  const hash = sha256(prevHash, paymentHashContent(row, allocations));
  const [payment] = await tx.insert(payments).values({ ...row, hash }).returning();
  if (allocations.length) {
    await tx.insert(paymentAllocations).values(allocations.map((a) => ({ ...a, companyId: ctx.companyId, paymentId: payment!.id })));
    for (const a of allocations) {
      await tx
        .update(salesDocuments)
        .set({ amountPaid: sql`${salesDocuments.amountPaid} + ${a.amount}::numeric`, updatedAt: new Date() })
        .where(and(eq(salesDocuments.companyId, ctx.companyId), eq(salesDocuments.id, a.documentId)));
    }
  }
  return payment!;
}

export interface RecordOptions {
  now?: Date;
}

export async function recordPayment(db: Db, ctx: CompanyContext, raw: unknown, opts: RecordOptions = {}): Promise<Idempotent<Payment>> {
  assertPermission(ctx, "payments.write");
  const data: PaymentData = paymentSchema.parse(raw);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const { idempotencyKey, ...request } = data;
    const previous = await claimIdempotencyKey(tx, ctx, idempotencyKey, "payment.record", request);
    if (previous) {
      const [p] = await tx.select().from(payments).where(and(eq(payments.companyId, ctx.companyId), eq(payments.id, previous.paymentId)));
      return { result: p!, replayed: true };
    }

    const [party] = await tx
      .select()
      .from(thirdParties)
      .where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.id, data.thirdPartyId)))
      .limit(1);
    if (!party || !party.isCustomer) throw new AppError("VALIDATION", "Client inconnu.", { thirdPartyId: "Client inconnu." });
    if (data.paymentDate > todayInParis(now)) {
      throw new AppError("VALIDATION", "La date du règlement ne peut pas être dans le futur.", { paymentDate: "Date future." });
    }

    const amount = dec(data.amount);
    const allocated = data.allocations.reduce((acc, a) => acc.plus(a.amount), new D(0));
    if (allocated.greaterThan(amount)) {
      throw new AppError("VALIDATION", "Le total imputé dépasse le montant du règlement.");
    }
    if (data.kind === "refund" && !allocated.equals(amount)) {
      throw new AppError("VALIDATION", "Un remboursement doit être entièrement imputé sur des factures trop perçues.");
    }

    // Verrous dans un ordre stable (évite les interblocages), puis contrôle des soldes.
    const ids = data.allocations.map((a) => a.documentId).sort();
    if (ids.length) {
      const locked = await tx
        .select({ id: salesDocuments.id, thirdPartyId: salesDocuments.thirdPartyId })
        .from(salesDocuments)
        .where(and(eq(salesDocuments.companyId, ctx.companyId), inArray(salesDocuments.id, ids)))
        .orderBy(asc(salesDocuments.id))
        .for("update");
      if (locked.length !== ids.length || locked.some((d) => d.thirdPartyId !== party.id)) {
        throw new AppError("VALIDATION", "Imputation sur une facture inconnue ou d'un autre client.");
      }
      const balances = await invoiceBalances(tx, ctx, { ids }, now);
      for (const a of data.allocations) {
        const b = balances.find((x) => x.id === a.documentId);
        if (!b) throw new AppError("VALIDATION", "Imputation possible uniquement sur une facture émise.");
        const remaining = dec(b.remaining);
        if (data.kind === "receipt" && dec(a.amount).greaterThan(remaining)) {
          throw new AppError("VALIDATION", `Facture ${b.number} : ${a.amount} € dépasse le reste à payer (${remaining.toFixed(2)} €).`);
        }
        if (data.kind === "refund" && dec(a.amount).greaterThan(remaining.negated())) {
          throw new AppError(
            "VALIDATION",
            `Facture ${b.number} : le remboursement (${a.amount} €) dépasse le trop-perçu (${remaining.negated().toFixed(2)} €).`,
          );
        }
      }
    }

    const account = await resolveTreasuryAccount(tx, ctx, data.method, data.bankAccountId);
    const sign = data.kind === "refund" ? -1 : 1;
    const signed = (v: string) => dec(v).times(sign).toFixed(2);
    const payment = await insertPayment(
      tx,
      ctx,
      {
        kind: data.kind,
        paymentDate: data.paymentDate,
        thirdPartyId: party.id,
        partyTypeSnapshot: party.partyType,
        method: data.method,
        amount: signed(data.amount),
        reference: data.reference ?? null,
        reversesPaymentId: null,
        bankAccountId: account.id,
        reason: null,
      },
      data.allocations.map((a) => ({ documentId: a.documentId, amount: signed(a.amount) })),
      now,
    );
    await postCustomerPayment(tx, await loadCompany(tx, ctx.companyId), {
      payment,
      allocations: data.allocations.map((a) => ({ documentId: a.documentId, amount: signed(a.amount) })),
      party,
    });
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: data.kind === "refund" ? "payment.refunded" : "payment.recorded",
      entityType: "payment",
      entityId: payment.id,
      payload: { number: payment.number, amount: payment.amount, method: payment.method, customer: party.code, hash: payment.hash },
    });
    await tx
      .update(idempotencyKeys)
      .set({ response: { paymentId: payment.id } })
      .where(and(eq(idempotencyKeys.companyId, ctx.companyId), eq(idempotencyKeys.key, idempotencyKey)));
    return { result: payment, replayed: false };
  });
}

/** Contre-passation : annule un règlement erroné par une écriture opposée, sans effacer l'original. */
export async function reversePayment(db: Db, ctx: CompanyContext, paymentId: string, raw: unknown, opts: RecordOptions = {}) {
  assertPermission(ctx, "payments.write");
  if (!isUuid(paymentId)) throw notFound("Règlement introuvable.");
  const data = reversalSchema.parse(raw);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx): Promise<Idempotent<Payment>> => {
    const previous = await claimIdempotencyKey(tx, ctx, data.idempotencyKey, "payment.reverse", { paymentId, reason: data.reason });
    if (previous) {
      const [p] = await tx.select().from(payments).where(and(eq(payments.companyId, ctx.companyId), eq(payments.id, previous.paymentId)));
      return { result: p!, replayed: true };
    }
    const [original] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.companyId, ctx.companyId), eq(payments.id, paymentId)))
      .limit(1);
    if (!original) throw notFound("Règlement introuvable.");
    if (original.kind === "reversal") throw new AppError("VALIDATION", "Une contre-passation ne se contre-passe pas.");
    const [already] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.reversesPaymentId, original.id)).limit(1);
    if (already) throw new AppError("CONFLICT", "Ce règlement a déjà été contre-passé.");

    const allocations = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, original.id));
    const ids = allocations.map((a) => a.documentId).sort();
    if (ids.length) {
      await tx
        .select({ id: salesDocuments.id })
        .from(salesDocuments)
        .where(and(eq(salesDocuments.companyId, ctx.companyId), inArray(salesDocuments.id, ids)))
        .orderBy(asc(salesDocuments.id))
        .for("update");
    }
    const neg = (v: string) => dec(v).negated().toFixed(2);
    const reversal = await insertPayment(
      tx,
      ctx,
      {
        kind: "reversal",
        paymentDate: todayInParis(now),
        thirdPartyId: original.thirdPartyId,
        partyTypeSnapshot: original.partyTypeSnapshot,
        method: original.method,
        amount: neg(original.amount),
        reference: original.number,
        reversesPaymentId: original.id,
        bankAccountId: original.bankAccountId,
        reason: data.reason,
      },
      allocations.map((a) => ({ documentId: a.documentId, amount: neg(a.amount) })),
      now,
    );
    await postCustomerPayment(tx, await loadCompany(tx, ctx.companyId), {
      payment: reversal,
      allocations: allocations.map((a) => ({ documentId: a.documentId, amount: neg(a.amount) })),
      party: (await tx.select().from(thirdParties).where(eq(thirdParties.id, original.thirdPartyId)))[0]!,
    });
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "payment.reversed",
      entityType: "payment",
      entityId: reversal.id,
      payload: { number: reversal.number, reverses: original.number, amount: reversal.amount, reason: data.reason, hash: reversal.hash },
    });
    await tx
      .update(idempotencyKeys)
      .set({ response: { paymentId: reversal.id } })
      .where(and(eq(idempotencyKeys.companyId, ctx.companyId), eq(idempotencyKeys.key, data.idempotencyKey)));
    return { result: reversal, replayed: false };
  });
}

// ─── Lecture ────────────────────────────────────────────────────────────────

export const PAYMENT_SORTS = ["date", "numero", "montant"] as const;

export async function listPayments(
  db: Executor,
  ctx: CompanyContext,
  f: Omit<ListParams<(typeof PAYMENT_SORTS)[number]>, "archived"> & { method?: Payment["method"]; kind?: Payment["kind"] },
) {
  assertPermission(ctx, "sales.read");
  const conditions: SQL[] = [eq(payments.companyId, ctx.companyId)];
  if (f.method) conditions.push(eq(payments.method, f.method));
  if (f.kind) conditions.push(eq(payments.kind, f.kind));
  if (f.q) {
    const p = likePattern(f.q);
    conditions.push(or(ilike(payments.number, p), ilike(payments.reference, p), ilike(thirdParties.name, p))!);
  }
  const where = and(...conditions);
  const column = { date: payments.chainSeq, numero: payments.number, montant: payments.amount }[f.sort];
  const join = and(eq(thirdParties.id, payments.thirdPartyId), eq(thirdParties.companyId, payments.companyId));
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({ p: payments, partyName: thirdParties.name })
      .from(payments)
      .innerJoin(thirdParties, join)
      .where(where)
      .orderBy(f.dir === "desc" ? desc(column) : asc(column))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(payments).innerJoin(thirdParties, join).where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r.p, partyName: r.partyName })), total, pageSize: PAGE_SIZE };
}

export async function getPayment(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "sales.read");
  if (!isUuid(id)) throw notFound("Règlement introuvable.");
  const [row] = await db
    .select({ p: payments, partyName: thirdParties.name, partyCode: thirdParties.code })
    .from(payments)
    .innerJoin(thirdParties, and(eq(thirdParties.id, payments.thirdPartyId), eq(thirdParties.companyId, payments.companyId)))
    .where(and(eq(payments.companyId, ctx.companyId), eq(payments.id, id)))
    .limit(1);
  if (!row) throw notFound("Règlement introuvable.");
  const [allocations, related] = await Promise.all([
    db
      .select({ documentId: paymentAllocations.documentId, amount: paymentAllocations.amount, number: salesDocuments.number })
      .from(paymentAllocations)
      .innerJoin(salesDocuments, eq(salesDocuments.id, paymentAllocations.documentId))
      .where(eq(paymentAllocations.paymentId, id)),
    db
      .select({ id: payments.id, number: payments.number, reversesPaymentId: payments.reversesPaymentId })
      .from(payments)
      .where(
        and(
          eq(payments.companyId, ctx.companyId),
          or(eq(payments.reversesPaymentId, id), row.p.reversesPaymentId ? eq(payments.id, row.p.reversesPaymentId) : sql`false`),
        ),
      ),
  ]);
  return {
    payment: row.p,
    partyName: row.partyName,
    partyCode: row.partyCode,
    allocations,
    reversedBy: related.find((r) => r.reversesPaymentId === id) ?? null,
    reverses: related.find((r) => r.id === row.p.reversesPaymentId) ?? null,
  };
}

/** Règlements imputés sur une facture. */
export async function paymentsForInvoice(db: Executor, ctx: CompanyContext, invoiceId: string) {
  assertPermission(ctx, "sales.read");
  return db
    .select({ id: payments.id, number: payments.number, kind: payments.kind, paymentDate: payments.paymentDate, method: payments.method, amount: paymentAllocations.amount })
    .from(paymentAllocations)
    .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
    .where(and(eq(paymentAllocations.companyId, ctx.companyId), eq(paymentAllocations.documentId, invoiceId)))
    .orderBy(asc(payments.chainSeq));
}
