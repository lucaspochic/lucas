import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db, Executor, Tx } from "../db/client";
import {
  bankAccounts,
  cashArchives,
  cashClosures,
  cashRegisters,
  cashSessions,
  cashTicketLines,
  cashTicketPayments,
  cashTickets,
  companies,
  idempotencyKeys,
  products,
  thirdParties,
  vatRates,
  type CashClosure,
  type CashRegister,
  type CashTicket,
  type Company,
} from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { canonicalJson } from "../security/canonical-json";
import { signText, verifyText, getSigningKey } from "../security/signing";
import { D, dec, roundMoney, type Dec } from "../domain/money";
import { computeTicketTotals, monthBounds } from "../domain/cash";
import { fiscalYearOf, todayInParis } from "../domain/numbering";
import { addDays } from "../domain/sales";
import { toCsv } from "../domain/csv";
import { createZip, readZip } from "../domain/zip";
import { GENESIS_HASH, appendAuditEvent } from "./audit";
import { postCashDifference, postCashTicket } from "./accounting";
import { isUuid } from "./third-parties";
import {
  cashRefundSchema,
  cashRegisterSchema,
  cashTicketSchema,
  closeSessionSchema,
  openSessionSchema,
} from "@/lib/schemas";

/**
 * Module caisse — conditions d'inaltérabilité, de sécurisation, de conservation et
 * d'archivage (CGI art. 286, I, 3° bis ; BOFiP BOI-TVA-DECLA-30-10-30).
 *
 *  - Tickets numérotés en continu par caisse, horodatés, en ajout seul, chaînés.
 *  - Corrections par ticket de remboursement lié (« opération moins »), jamais par modification.
 *  - Mode école : tickets chaînés mais exclus des totaux et de la comptabilité.
 *  - Clôtures journalières, mensuelles et annuelles automatiques (cumulatives) : grand total
 *    de période, total perpétuel jamais remis à zéro ; chaînées et signées (Ed25519).
 *  - Archives : ZIP au format ouvert, notice en français, manifeste signé.
 */

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const chainHash = (prev: string, content: unknown) => sha(`${prev}\n${canonicalJson(content)}`);

// ─── Caisses et sessions ────────────────────────────────────────────────────

export async function createRegister(db: Db, ctx: CompanyContext, raw: unknown) {
  assertPermission(ctx, "company.update");
  const data = cashRegisterSchema.parse(raw);
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.companyId, ctx.companyId),
          eq(bankAccounts.kind, "cash"),
          isNull(bankAccounts.archivedAt),
          data.cashAccountId ? eq(bankAccounts.id, data.cashAccountId) : eq(bankAccounts.isDefault, true),
        ),
      )
      .limit(1);
    if (!account) throw new AppError("VALIDATION", "Aucun compte de caisse (530) disponible : créez-en un dans Trésorerie.");
    const [dup] = await tx.select({ id: cashRegisters.id }).from(cashRegisters).where(and(eq(cashRegisters.companyId, ctx.companyId), eq(cashRegisters.code, data.code))).limit(1);
    if (dup) throw new AppError("CONFLICT", "Ce numéro de caisse existe déjà.", { code: "Déjà utilisé." });
    const [register] = await tx.insert(cashRegisters).values({ companyId: ctx.companyId, code: data.code, name: data.name, cashAccountId: account.id }).returning();
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "cash_register.created",
      entityType: "cash_register",
      entityId: register!.id,
      payload: { code: register!.code, name: register!.name },
    });
    return register!;
  });
}

export async function listRegisters(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "cash.operate");
  return db.select().from(cashRegisters).where(and(eq(cashRegisters.companyId, ctx.companyId), isNull(cashRegisters.archivedAt))).orderBy(asc(cashRegisters.code));
}

async function getRegisterRow(tx: Executor, ctx: CompanyContext, id: string): Promise<CashRegister> {
  if (!isUuid(id)) throw notFound("Caisse introuvable.");
  const [r] = await tx.select().from(cashRegisters).where(and(eq(cashRegisters.companyId, ctx.companyId), eq(cashRegisters.id, id))).limit(1);
  if (!r) throw notFound("Caisse introuvable.");
  return r;
}

/** Caisse verrouillée pour la transaction : sérialise tickets, sessions et clôtures d'une même caisse. */
async function lockRegister(tx: Tx, ctx: CompanyContext, id: string) {
  const register = await getRegisterRow(tx, ctx, id);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"cash:" + register.id}))`);
  return register;
}

export async function getRegister(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "cash.operate");
  const register = await getRegisterRow(db, ctx, id);
  const [[session], [lastClosure], [{ perpetual } = { perpetual: "0" }]] = await Promise.all([
    db.select().from(cashSessions).where(and(eq(cashSessions.registerId, id), isNull(cashSessions.closedAt))).limit(1),
    db.select().from(cashClosures).where(and(eq(cashClosures.registerId, id), eq(cashClosures.kind, "day"))).orderBy(desc(cashClosures.periodStart)).limit(1),
    db
      .select({ perpetual: sql<string>`coalesce(sum(case when ${cashTickets.training} then 0 else ${cashTickets.totalInclTax} end), 0)::text` })
      .from(cashTickets)
      .where(eq(cashTickets.registerId, id)),
  ]);
  return { register, openSession: session ?? null, lastDayClosure: lastClosure ?? null, perpetualTotal: dec(perpetual).toFixed(2) };
}

export async function openSession(db: Db, ctx: CompanyContext, registerId: string, raw: unknown, opts: { now?: Date } = {}) {
  assertPermission(ctx, "cash.operate");
  const data = openSessionSchema.parse(raw);
  return db.transaction(async (tx) => {
    const register = await lockRegister(tx, ctx, registerId);
    const [open] = await tx.select({ id: cashSessions.id }).from(cashSessions).where(and(eq(cashSessions.registerId, register.id), isNull(cashSessions.closedAt))).limit(1);
    if (open) throw new AppError("CONFLICT", "Une session est déjà ouverte sur cette caisse.");
    const [session] = await tx
      .insert(cashSessions)
      .values({ companyId: ctx.companyId, registerId: register.id, openedAt: opts.now ?? new Date(), openedBy: ctx.userId, openingFloat: dec(data.openingFloat).toFixed(2) })
      .returning();
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "cash_session.opened",
      entityType: "cash_register",
      entityId: register.id,
      payload: { register: register.code, openingFloat: session!.openingFloat },
    });
    return session!;
  });
}

async function expectedCash(tx: Executor, sessionId: string, openingFloat: string) {
  const [r] = await tx
    .select({ cash: sql<string>`coalesce(sum(${cashTicketPayments.amount}), 0)::text` })
    .from(cashTicketPayments)
    .innerJoin(cashTickets, eq(cashTickets.id, cashTicketPayments.ticketId))
    .where(and(eq(cashTickets.sessionId, sessionId), eq(cashTicketPayments.method, "cash"), eq(cashTickets.training, false)));
  return dec(openingFloat).plus(r!.cash);
}

export async function closeSession(db: Db, ctx: CompanyContext, registerId: string, raw: unknown, opts: { now?: Date } = {}) {
  assertPermission(ctx, "cash.operate");
  const data = closeSessionSchema.parse(raw);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const register = await lockRegister(tx, ctx, registerId);
    const [session] = await tx
      .select()
      .from(cashSessions)
      .where(and(eq(cashSessions.registerId, register.id), isNull(cashSessions.closedAt)))
      .for("update")
      .limit(1);
    if (!session) throw new AppError("VALIDATION", "Aucune session ouverte sur cette caisse.");
    const expected = await expectedCash(tx, session.id, session.openingFloat);
    const counted = dec(data.countedCash);
    const difference = counted.minus(expected);
    const [closed] = await tx
      .update(cashSessions)
      .set({ closedAt: now, closedBy: ctx.userId, expectedCash: expected.toFixed(2), countedCash: counted.toFixed(2), difference: difference.toFixed(2), note: data.note ?? null })
      .where(eq(cashSessions.id, session.id))
      .returning();
    const [company] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
    const [account] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, register.cashAccountId)).limit(1);
    await postCashDifference(tx, company!, {
      sessionId: session.id,
      registerCode: register.code,
      date: todayInParis(now),
      difference: difference.toFixed(2),
      cashLedgerAccount: account!.ledgerAccount,
      cashAccountName: account!.name,
    });
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "cash_session.closed",
      entityType: "cash_register",
      entityId: register.id,
      payload: { register: register.code, expected: expected.toFixed(2), counted: counted.toFixed(2), difference: difference.toFixed(2) },
    });
    return closed!;
  });
}

/** Ventilation à partir des totaux de ligne enregistrés (identiques au ticket remis). */
const storedLine = (l: { totalInclTax: string; vatRate: string }) => ({ quantity: "1", unitPriceInclTax: l.totalInclTax, vatRate: l.vatRate });

// ─── Tickets ────────────────────────────────────────────────────────────────

interface TicketContent {
  ticket: Omit<CashTicket, "hash">;
  lines: { position: number; productId: string | null; label: string; kind: string; quantity: string; unitPriceInclTax: string; vatRate: string; totalInclTax: string }[];
  payments: { method: string; amount: string }[];
}

/** Contenu couvert par l'empreinte d'un ticket (BOFiP §50 : n°, horodatage, caisse, TTC, détail, paiements). */
function ticketHashContent(c: TicketContent) {
  const t = c.ticket;
  return {
    companyId: t.companyId,
    registerId: t.registerId,
    seq: t.seq,
    number: t.number,
    kind: t.kind,
    refundOfId: t.refundOfId,
    recordedAt: t.recordedAt.toISOString(),
    businessDate: t.businessDate,
    operatorId: t.operatorId,
    thirdPartyId: t.thirdPartyId,
    training: t.training,
    totals: [t.totalExclTax, t.totalVat, t.totalInclTax],
    reason: t.reason,
    lines: c.lines.map((l) => [l.position, l.productId, l.label, l.kind, l.quantity, l.unitPriceInclTax, l.vatRate, l.totalInclTax]),
    payments: [...c.payments].map((p) => [p.method, p.amount]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)),
  };
}

async function claimKey(tx: Tx, ctx: CompanyContext, key: string, operation: string, request: unknown) {
  const requestHash = sha(canonicalJson(request));
  const inserted = await tx.insert(idempotencyKeys).values({ companyId: ctx.companyId, key, operation, requestHash }).onConflictDoNothing().returning({ key: idempotencyKeys.key });
  if (inserted.length) return null;
  const [existing] = await tx.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.companyId, ctx.companyId), eq(idempotencyKeys.key, key))).limit(1);
  if (!existing || existing.operation !== operation || existing.requestHash !== requestHash) {
    throw new AppError("CONFLICT", "Cette demande a déjà été utilisée pour une autre opération. Rechargez la page.");
  }
  return (existing.response as { id: string }).id;
}

async function insertTicket(
  tx: Tx,
  ctx: CompanyContext,
  register: CashRegister,
  sessionId: string,
  input: {
    kind: "sale" | "refund";
    refundOfId: string | null;
    reason: string | null;
    thirdPartyId: string | null;
    training: boolean;
    lines: TicketContent["lines"];
    payments: TicketContent["payments"];
    totals: { totalExclTax: string; totalVat: string; totalInclTax: string };
  },
  now: Date,
) {
  const businessDate = todayInParis(now);
  const [dayClosed] = await tx
    .select({ id: cashClosures.id })
    .from(cashClosures)
    .where(and(eq(cashClosures.registerId, register.id), eq(cashClosures.kind, "day"), eq(cashClosures.periodStart, businessDate)))
    .limit(1);
  if (dayClosed) throw new AppError("VALIDATION", "La journée est clôturée sur cette caisse : aucun ticket ne peut plus y être enregistré.");

  const [last] = await tx.select({ seq: cashTickets.seq, hash: cashTickets.hash }).from(cashTickets).where(eq(cashTickets.registerId, register.id)).orderBy(desc(cashTickets.seq)).limit(1);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const ticket = {
    id: crypto.randomUUID(),
    companyId: ctx.companyId,
    registerId: register.id,
    sessionId,
    seq,
    number: `${register.code}-${String(seq).padStart(6, "0")}`,
    kind: input.kind,
    refundOfId: input.refundOfId,
    recordedAt: now,
    businessDate,
    operatorId: ctx.userId,
    thirdPartyId: input.thirdPartyId,
    training: input.training,
    totalExclTax: input.totals.totalExclTax,
    totalVat: input.totals.totalVat,
    totalInclTax: input.totals.totalInclTax,
    reason: input.reason,
    prevHash,
  };
  const hash = chainHash(prevHash, ticketHashContent({ ticket, lines: input.lines, payments: input.payments }));
  const [row] = await tx.insert(cashTickets).values({ ...ticket, hash }).returning();
  await tx.insert(cashTicketLines).values(input.lines.map((l) => ({ ...l, kind: l.kind as "good" | "service", companyId: ctx.companyId, ticketId: row!.id })));
  await tx.insert(cashTicketPayments).values(input.payments.map((p) => ({ ...p, method: p.method as "cash", companyId: ctx.companyId, ticketId: row!.id })));
  const [company] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  const [account] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, register.cashAccountId)).limit(1);
  await postCashTicket(tx, company!, {
    ticket: row!,
    lines: input.lines.map((l) => ({ kind: l.kind as "good" | "service", vatRate: l.vatRate, totalInclTax: l.totalInclTax })),
    payments: input.payments,
    cashLedgerAccount: account!.ledgerAccount,
    cashAccountName: account!.name,
  });
  return row!;
}

async function openSessionFor(tx: Executor, registerId: string) {
  const [session] = await tx.select().from(cashSessions).where(and(eq(cashSessions.registerId, registerId), isNull(cashSessions.closedAt))).limit(1);
  if (!session) throw new AppError("VALIDATION", "Ouvrez d'abord la caisse (fond de caisse).");
  return session;
}

export async function recordTicket(db: Db, ctx: CompanyContext, registerId: string, raw: unknown, opts: { now?: Date } = {}) {
  assertPermission(ctx, "cash.operate");
  const data = cashTicketSchema.parse(raw);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const { idempotencyKey, ...request } = data;
    const previous = await claimKey(tx, ctx, idempotencyKey, "cash.ticket", { registerId, ...request });
    if (previous) {
      const [t] = await tx.select().from(cashTickets).where(eq(cashTickets.id, previous));
      return { result: t!, replayed: true };
    }
    const register = await lockRegister(tx, ctx, registerId);
    const session = await openSessionFor(tx, register.id);
    await closeDuePeriods(tx, ctx, register, now, { includeToday: false });

    const allowed = await tx.select({ rate: vatRates.rate }).from(vatRates).where(and(eq(vatRates.companyId, ctx.companyId), eq(vatRates.active, true)));
    for (const l of data.lines) {
      if (!allowed.some((r) => dec(r.rate).equals(dec(l.vatRate)))) throw new AppError("VALIDATION", `Taux de TVA ${l.vatRate} % non paramétré pour l'entreprise.`);
    }
    if (data.thirdPartyId) {
      const [party] = await tx.select({ id: thirdParties.id }).from(thirdParties).where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.id, data.thirdPartyId))).limit(1);
      if (!party) throw new AppError("VALIDATION", "Client inconnu.");
    }
    const totals = computeTicketTotals(data.lines);
    const paid = data.payments.reduce((a, p) => a.plus(p.amount), new D(0));
    if (!paid.equals(dec(totals.totalInclTax))) {
      throw new AppError("VALIDATION", `Le total des paiements (${paid.toFixed(2)} €) doit égaler le total du ticket (${totals.totalInclTax} €).`);
    }
    const ticket = await insertTicket(
      tx,
      ctx,
      register,
      session.id,
      {
        kind: "sale",
        refundOfId: null,
        reason: null,
        thirdPartyId: data.thirdPartyId ?? null,
        training: data.training,
        lines: data.lines.map((l, i) => ({
          position: i + 1,
          productId: l.productId ?? null,
          label: l.discountPercent && !dec(l.discountPercent).isZero() ? `${l.label} (remise ${dec(l.discountPercent).toString().replace(".", ",")} %)` : l.label,
          kind: l.kind,
          quantity: dec(l.quantity).toFixed(3),
          unitPriceInclTax: dec(l.unitPriceInclTax).times(new D(100).minus(l.discountPercent ?? "0")).dividedBy(100).toFixed(4),
          vatRate: dec(l.vatRate).toFixed(2),
          totalInclTax: totals.lineTotals[i]!,
        })),
        payments: data.payments.map((p) => ({ method: p.method, amount: dec(p.amount).toFixed(2) })),
        totals,
      },
      now,
    );
    await tx.update(idempotencyKeys).set({ response: { id: ticket.id } }).where(and(eq(idempotencyKeys.companyId, ctx.companyId), eq(idempotencyKeys.key, idempotencyKey)));
    return { result: ticket, replayed: false };
  });
}

export async function refundTicket(db: Db, ctx: CompanyContext, ticketId: string, raw: unknown, opts: { now?: Date } = {}) {
  assertPermission(ctx, "cash.operate");
  if (!isUuid(ticketId)) throw notFound("Ticket introuvable.");
  const data = cashRefundSchema.parse(raw);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const { idempotencyKey, ...request } = data;
    const previous = await claimKey(tx, ctx, idempotencyKey, "cash.refund", { ticketId, ...request });
    if (previous) {
      const [t] = await tx.select().from(cashTickets).where(eq(cashTickets.id, previous));
      return { result: t!, replayed: true };
    }
    const [original] = await tx.select().from(cashTickets).where(and(eq(cashTickets.companyId, ctx.companyId), eq(cashTickets.id, ticketId))).limit(1);
    if (!original) throw notFound("Ticket introuvable.");
    if (original.kind !== "sale") throw new AppError("VALIDATION", "Seul un ticket de vente peut être remboursé.");
    const register = await lockRegister(tx, ctx, original.registerId);
    const session = await openSessionFor(tx, register.id);
    await closeDuePeriods(tx, ctx, register, now, { includeToday: false });

    const lines = await tx.select().from(cashTicketLines).where(eq(cashTicketLines.ticketId, original.id)).orderBy(asc(cashTicketLines.position));
    // Quantités déjà remboursées par ligne (libellé + position d'origine conservés dans le libellé du remboursement).
    const refunds = await tx.select({ id: cashTickets.id }).from(cashTickets).where(eq(cashTickets.refundOfId, original.id));
    const refundedLines = refunds.length
      ? await tx.select().from(cashTicketLines).where(inArray(cashTicketLines.ticketId, refunds.map((r) => r.id)))
      : [];
    const refundedOf = (pos: number) => refundedLines.filter((l) => l.label.endsWith(`[ligne ${pos}]`));
    const wanted = data.lines.length
      ? data.lines
      : lines.map((l) => ({ position: l.position, quantity: dec(l.quantity).minus(refundedOf(l.position).reduce((a, r) => a.plus(dec(r.quantity).abs()), new D(0))).toString() })).filter((w) => dec(w.quantity).greaterThan(0));
    if (!wanted.length) throw new AppError("VALIDATION", `Le ticket ${original.number} a déjà été entièrement remboursé.`);
    if (new Set(wanted.map((w) => w.position)).size !== wanted.length) throw new AppError("VALIDATION", "Une même ligne apparaît deux fois.");
    const refundLines = wanted.map((w, i) => {
      const src = lines.find((l) => l.position === w.position);
      if (!src) throw new AppError("VALIDATION", `Ligne ${w.position} inconnue sur le ticket ${original.number}.`);
      const previous = refundedOf(w.position);
      const remainingQty = dec(src.quantity).minus(previous.reduce((a, r) => a.plus(dec(r.quantity).abs()), new D(0)));
      const remainingAmount = dec(src.totalInclTax).plus(previous.reduce((a, r) => a.plus(r.totalInclTax), new D(0)));
      const qty = dec(w.quantity);
      if (qty.lessThanOrEqualTo(0) || qty.greaterThan(remainingQty)) {
        throw new AppError("VALIDATION", `Ligne ${w.position} : ${remainingQty.toString().replace(".", ",")} au plus restent remboursables.`);
      }
      // Montant dérivé du total encaissé : prorata, et solde exact au dernier remboursement.
      const amount = qty.equals(remainingQty) ? remainingAmount : roundMoney(dec(src.totalInclTax).times(qty).dividedBy(src.quantity));
      return {
        position: i + 1,
        productId: src.productId,
        label: `${src.label} [ligne ${src.position}]`,
        kind: src.kind,
        quantity: qty.negated().toFixed(3),
        unitPriceInclTax: src.unitPriceInclTax,
        vatRate: src.vatRate,
        totalInclTax: amount.negated().toFixed(2),
      };
    });
    const totals = computeTicketTotals(refundLines.map(storedLine));
    const paid = data.payments.reduce((a, p) => a.plus(p.amount), new D(0));
    if (!paid.equals(dec(totals.totalInclTax).negated())) {
      throw new AppError("VALIDATION", `Le total remboursé (${paid.toFixed(2)} €) doit égaler le montant du remboursement (${dec(totals.totalInclTax).negated().toFixed(2)} €).`);
    }
    const ticket = await insertTicket(
      tx,
      ctx,
      register,
      session.id,
      {
        kind: "refund",
        refundOfId: original.id,
        reason: data.reason,
        thirdPartyId: original.thirdPartyId,
        training: original.training,
        lines: refundLines,
        payments: data.payments.map((p) => ({ method: p.method, amount: dec(p.amount).negated().toFixed(2) })),
        totals,
      },
      now,
    );
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "cash_ticket.refunded",
      entityType: "cash_ticket",
      entityId: ticket.id,
      payload: { number: ticket.number, refundOf: original.number, amount: ticket.totalInclTax, reason: data.reason },
    });
    await tx.update(idempotencyKeys).set({ response: { id: ticket.id } }).where(and(eq(idempotencyKeys.companyId, ctx.companyId), eq(idempotencyKeys.key, idempotencyKey)));
    return { result: ticket, replayed: false };
  });
}

export async function listTickets(db: Executor, ctx: CompanyContext, registerId: string, opts: { date?: string; limit?: number } = {}) {
  assertPermission(ctx, "cash.operate");
  await getRegisterRow(db, ctx, registerId);
  const conditions = [eq(cashTickets.registerId, registerId)];
  if (opts.date) conditions.push(eq(cashTickets.businessDate, opts.date));
  return db.select().from(cashTickets).where(and(...conditions)).orderBy(desc(cashTickets.seq)).limit(opts.limit ?? 50);
}

export async function getTicket(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "cash.operate");
  if (!isUuid(id)) throw notFound("Ticket introuvable.");
  const [ticket] = await db.select().from(cashTickets).where(and(eq(cashTickets.companyId, ctx.companyId), eq(cashTickets.id, id))).limit(1);
  if (!ticket) throw notFound("Ticket introuvable.");
  const [lines, pays, [register], [company], refunds, [original]] = await Promise.all([
    db.select().from(cashTicketLines).where(eq(cashTicketLines.ticketId, id)).orderBy(asc(cashTicketLines.position)),
    db.select().from(cashTicketPayments).where(eq(cashTicketPayments.ticketId, id)),
    db.select().from(cashRegisters).where(eq(cashRegisters.id, ticket.registerId)),
    db.select().from(companies).where(eq(companies.id, ctx.companyId)),
    db.select({ id: cashTickets.id, number: cashTickets.number, total: cashTickets.totalInclTax }).from(cashTickets).where(eq(cashTickets.refundOfId, id)),
    ticket.refundOfId ? db.select({ id: cashTickets.id, number: cashTickets.number }).from(cashTickets).where(eq(cashTickets.id, ticket.refundOfId)) : Promise.resolve([]),
  ]);
  const totals = computeTicketTotals(lines.map(storedLine));
  const refundLines = refunds.length ? await db.select().from(cashTicketLines).where(inArray(cashTicketLines.ticketId, refunds.map((r) => r.id))) : [];
  // Reste remboursable par ligne (quantité et montant), selon la même règle que refundTicket.
  const refundable = lines.map((l) => {
    const previous = refundLines.filter((r) => r.label.endsWith(`[ligne ${l.position}]`));
    return {
      position: l.position,
      label: l.label,
      quantity: l.quantity,
      totalInclTax: l.totalInclTax,
      remaining: dec(l.quantity).minus(previous.reduce((a, r) => a.plus(dec(r.quantity).abs()), new D(0))).toString(),
      remainingAmount: dec(l.totalInclTax).plus(previous.reduce((a, r) => a.plus(r.totalInclTax), new D(0))).toFixed(2),
    };
  });
  return { ticket, lines, payments: pays, register: register!, company: company!, vat: totals.vat, refunds, original: original ?? null, refundable };
}

// ─── Clôtures ───────────────────────────────────────────────────────────────

type Breakdown = Record<string, string>;
const addInto = (target: Map<string, Dec>, key: string, v: string | Dec) => target.set(key, (target.get(key) ?? new D(0)).plus(v));
const toRecord = (m: Map<string, Dec>): Breakdown => Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.toFixed(2)]));

function closureHashContent(c: Omit<CashClosure, "id" | "hash" | "signature" | "keyId" | "closedAt" | "closedBy">) {
  return {
    companyId: c.companyId,
    registerId: c.registerId,
    kind: c.kind,
    period: [c.periodStart, c.periodEnd],
    seq: c.seq,
    tickets: [c.ticketCount, c.firstTicketSeq, c.lastTicketSeq, c.lastTicketHash],
    totals: [c.totalExclTax, c.totalVat, c.grandTotal, c.perpetualTotal, c.perpetualAbsoluteTotal],
    vat: c.vatBreakdown,
    payments: c.paymentBreakdown,
  };
}

async function insertClosure(tx: Tx, register: CashRegister, data: Omit<CashClosure, "id" | "seq" | "prevHash" | "hash" | "signature" | "keyId">) {
  const [last] = await tx.select({ seq: cashClosures.seq, hash: cashClosures.hash }).from(cashClosures).where(eq(cashClosures.registerId, register.id)).orderBy(desc(cashClosures.seq)).limit(1);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const content = { ...data, seq, prevHash };
  const hash = chainHash(prevHash, closureHashContent(content));
  const { signature, keyId } = signText(hash);
  const [row] = await tx.insert(cashClosures).values({ ...content, hash, signature, keyId }).returning();
  return row!;
}

async function dayClosure(tx: Tx, register: CashRegister, date: string, closedBy: string | null, now: Date) {
  const tickets = await tx
    .select()
    .from(cashTickets)
    .where(and(eq(cashTickets.registerId, register.id), eq(cashTickets.businessDate, date)))
    .orderBy(asc(cashTickets.seq));
  const real = tickets.filter((t) => !t.training);
  const ids = real.map((t) => t.id);
  const [lines, pays, [prev]] = await Promise.all([
    ids.length ? tx.select().from(cashTicketLines).where(inArray(cashTicketLines.ticketId, ids)) : Promise.resolve([]),
    ids.length ? tx.select().from(cashTicketPayments).where(inArray(cashTicketPayments.ticketId, ids)) : Promise.resolve([]),
    tx.select().from(cashClosures).where(and(eq(cashClosures.registerId, register.id), eq(cashClosures.kind, "day"))).orderBy(desc(cashClosures.periodStart)).limit(1),
  ]);
  const vat = new Map<string, Dec>();
  for (const t of real) {
    const own = lines.filter((l) => l.ticketId === t.id);
    for (const v of computeTicketTotals(own.map(storedLine)).vat) {
      addInto(vat, `${v.vatRate}:ht`, v.exclTax);
      addInto(vat, `${v.vatRate}:tva`, v.vat);
    }
  }
  const payments = new Map<string, Dec>();
  for (const p of pays) addInto(payments, p.method, p.amount);
  const sum = (k: "totalExclTax" | "totalVat" | "totalInclTax") => real.reduce((a, t) => a.plus(t[k]), new D(0));
  const grand = sum("totalInclTax");
  const absolute = real.reduce((a, t) => a.plus(dec(t.totalInclTax).abs()), new D(0));
  const lastTicket = tickets[tickets.length - 1];
  return insertClosure(tx, register, {
    companyId: register.companyId,
    registerId: register.id,
    kind: "day",
    periodStart: date,
    periodEnd: date,
    ticketCount: real.length,
    firstTicketSeq: tickets[0]?.seq ?? null,
    lastTicketSeq: lastTicket?.seq ?? null,
    lastTicketHash: lastTicket?.hash ?? null,
    totalExclTax: sum("totalExclTax").toFixed(2),
    totalVat: sum("totalVat").toFixed(2),
    grandTotal: grand.toFixed(2),
    perpetualTotal: dec(prev?.perpetualTotal ?? "0").plus(grand).toFixed(2),
    perpetualAbsoluteTotal: dec(prev?.perpetualAbsoluteTotal ?? "0").plus(absolute).toFixed(2),
    vatBreakdown: toRecord(vat),
    paymentBreakdown: toRecord(payments),
    closedAt: now,
    closedBy,
  });
}

async function aggregateClosure(tx: Tx, register: CashRegister, kind: "month" | "year", start: string, end: string, closedBy: string | null, now: Date) {
  const source = kind === "month" ? "day" : "month";
  const parts = await tx
    .select()
    .from(cashClosures)
    .where(and(eq(cashClosures.registerId, register.id), eq(cashClosures.kind, source), gte(cashClosures.periodStart, start), lte(cashClosures.periodEnd, end)))
    .orderBy(asc(cashClosures.periodStart));
  const vat = new Map<string, Dec>();
  const payments = new Map<string, Dec>();
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.vatBreakdown as Breakdown)) addInto(vat, k, v);
    for (const [k, v] of Object.entries(p.paymentBreakdown as Breakdown)) addInto(payments, k, v);
  }
  const sum = (k: "totalExclTax" | "totalVat" | "grandTotal") => parts.reduce((a, p) => a.plus(p[k]), new D(0)).toFixed(2);
  const last = parts[parts.length - 1];
  const [prevSame] = await tx.select().from(cashClosures).where(and(eq(cashClosures.registerId, register.id), eq(cashClosures.kind, kind))).orderBy(desc(cashClosures.periodStart)).limit(1);
  return insertClosure(tx, register, {
    companyId: register.companyId,
    registerId: register.id,
    kind,
    periodStart: start,
    periodEnd: end,
    ticketCount: parts.reduce((a, p) => a + p.ticketCount, 0),
    firstTicketSeq: parts.find((p) => p.firstTicketSeq !== null)?.firstTicketSeq ?? null,
    lastTicketSeq: [...parts].reverse().find((p) => p.lastTicketSeq !== null)?.lastTicketSeq ?? null,
    lastTicketHash: [...parts].reverse().find((p) => p.lastTicketHash !== null)?.lastTicketHash ?? null,
    totalExclTax: sum("totalExclTax"),
    totalVat: sum("totalVat"),
    grandTotal: sum("grandTotal"),
    perpetualTotal: last?.perpetualTotal ?? prevSame?.perpetualTotal ?? "0.00",
    perpetualAbsoluteTotal: last?.perpetualAbsoluteTotal ?? prevSame?.perpetualAbsoluteTotal ?? "0.00",
    vatBreakdown: toRecord(vat),
    paymentBreakdown: toRecord(payments),
    closedAt: now,
    closedBy,
  });
}

/**
 * Crée les clôtures dues, dans l'ordre : jours ayant eu des tickets (avant aujourd'hui,
 * ou aujourd'hui inclus sur demande), puis mois révolus, puis exercices révolus.
 * Idempotent ; appelé automatiquement à chaque ticket et par l'action « Clôturer ».
 */
export async function closeDuePeriods(tx: Tx, ctx: CompanyContext, register: CashRegister, now: Date, opts: { includeToday: boolean }) {
  const today = todayInParis(now);
  const [company] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  const closedBy = ctx.userId;
  const created: CashClosure[] = [];
  const days = await tx
    .selectDistinct({ date: cashTickets.businessDate })
    .from(cashTickets)
    .leftJoin(
      cashClosures,
      and(eq(cashClosures.registerId, cashTickets.registerId), eq(cashClosures.kind, "day"), eq(cashClosures.periodStart, cashTickets.businessDate)),
    )
    .where(and(eq(cashTickets.registerId, register.id), isNull(cashClosures.id), opts.includeToday ? lte(cashTickets.businessDate, today) : sql`${cashTickets.businessDate} < ${today}`))
    .orderBy(asc(cashTickets.businessDate));
  for (const d of days) created.push(await dayClosure(tx, register, d.date, closedBy, now));

  // Mois révolus ayant au moins une clôture journalière et pas encore de clôture mensuelle.
  const dayClosures = await tx.select({ start: cashClosures.periodStart }).from(cashClosures).where(and(eq(cashClosures.registerId, register.id), eq(cashClosures.kind, "day")));
  const months = [...new Set(dayClosures.map((d) => d.start.slice(0, 7)))].sort();
  for (const m of months) {
    const { start, end } = monthBounds(`${m}-01`);
    if (end >= today) continue;
    const [exists] = await tx.select({ id: cashClosures.id }).from(cashClosures).where(and(eq(cashClosures.registerId, register.id), eq(cashClosures.kind, "month"), eq(cashClosures.periodStart, start))).limit(1);
    if (!exists) created.push(await aggregateClosure(tx, register, "month", start, end, closedBy, now));
  }

  // Exercices révolus.
  const monthClosures = await tx.select({ start: cashClosures.periodStart }).from(cashClosures).where(and(eq(cashClosures.registerId, register.id), eq(cashClosures.kind, "month")));
  const years = [...new Set(monthClosures.map((m) => fiscalYearOf(m.start, company!.fiscalYearStartMonth)))].sort();
  for (const y of years) {
    const sm = company!.fiscalYearStartMonth;
    const startYear = sm === 1 ? y : y - 1;
    const start = `${startYear}-${String(sm).padStart(2, "0")}-01`;
    const end = addDays(`${startYear + 1}-${String(sm).padStart(2, "0")}-01`, -1);
    if (end >= today) continue;
    const [exists] = await tx.select({ id: cashClosures.id }).from(cashClosures).where(and(eq(cashClosures.registerId, register.id), eq(cashClosures.kind, "year"), eq(cashClosures.periodStart, start))).limit(1);
    if (!exists) created.push(await aggregateClosure(tx, register, "year", start, end, closedBy, now));
  }
  return created;
}

/** Action « Clôturer la journée » : clôture aujourd'hui (et tout ce qui est dû). */
export async function closeToday(db: Db, ctx: CompanyContext, registerId: string, opts: { now?: Date } = {}) {
  assertPermission(ctx, "cash.close");
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const register = await lockRegister(tx, ctx, registerId);
    const [open] = await tx.select({ id: cashSessions.id }).from(cashSessions).where(and(eq(cashSessions.registerId, register.id), isNull(cashSessions.closedAt))).limit(1);
    if (open) throw new AppError("VALIDATION", "Fermez d'abord la session de caisse (comptage des espèces).");
    const created = await closeDuePeriods(tx, ctx, register, now, { includeToday: true });
    if (created.length) {
      await appendAuditEvent(tx, {
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: "cash_closure.created",
        entityType: "cash_register",
        entityId: register.id,
        payload: { register: register.code, closures: created.map((c) => `${c.kind}:${c.periodStart}`).join(", ") },
      });
    }
    return created;
  });
}

export async function listClosures(db: Executor, ctx: CompanyContext, registerId: string, kind?: CashClosure["kind"]) {
  assertPermission(ctx, "cash.operate");
  await getRegisterRow(db, ctx, registerId);
  const conditions = [eq(cashClosures.registerId, registerId)];
  if (kind) conditions.push(eq(cashClosures.kind, kind));
  return db.select().from(cashClosures).where(and(...conditions)).orderBy(desc(cashClosures.seq)).limit(100);
}

export async function listSessions(db: Executor, ctx: CompanyContext, registerId: string) {
  assertPermission(ctx, "cash.operate");
  await getRegisterRow(db, ctx, registerId);
  return db.select().from(cashSessions).where(eq(cashSessions.registerId, registerId)).orderBy(desc(cashSessions.openedAt)).limit(30);
}

// ─── Intégrité ──────────────────────────────────────────────────────────────

export async function verifyRegister(db: Executor, companyId: string, registerId: string) {
  const errors: string[] = [];
  const tickets = await db.select().from(cashTickets).where(and(eq(cashTickets.companyId, companyId), eq(cashTickets.registerId, registerId))).orderBy(asc(cashTickets.seq));
  const ids = tickets.map((t) => t.id);
  const [lines, pays] = ids.length
    ? await Promise.all([
        db.select().from(cashTicketLines).where(inArray(cashTicketLines.ticketId, ids)),
        db.select().from(cashTicketPayments).where(inArray(cashTicketPayments.ticketId, ids)),
      ])
    : [[], []];
  let prev = GENESIS_HASH;
  tickets.forEach((t, i) => {
    if (t.seq !== i + 1) errors.push(`Ticket n° ${i + 1} manquant (rupture de séquence).`);
    if (t.prevHash !== prev) errors.push(`Ticket ${t.number} : chaînage rompu.`);
    const own = lines.filter((l) => l.ticketId === t.id).sort((a, b) => a.position - b.position);
    const content = ticketHashContent({
      ticket: t,
      lines: own.map((l) => ({ position: l.position, productId: l.productId, label: l.label, kind: l.kind, quantity: l.quantity, unitPriceInclTax: l.unitPriceInclTax, vatRate: l.vatRate, totalInclTax: l.totalInclTax })),
      payments: pays.filter((p) => p.ticketId === t.id).map((p) => ({ method: p.method, amount: p.amount })),
    });
    if (chainHash(t.prevHash, content) !== t.hash) errors.push(`Ticket ${t.number} : contenu modifié après enregistrement.`);
    prev = t.hash;
  });
  const closures = await db.select().from(cashClosures).where(and(eq(cashClosures.companyId, companyId), eq(cashClosures.registerId, registerId))).orderBy(asc(cashClosures.seq));
  let prevC = GENESIS_HASH;
  closures.forEach((c, i) => {
    const label = `Clôture ${c.kind} ${c.periodStart}`;
    if (c.seq !== i + 1) errors.push(`${label} : rupture de séquence.`);
    if (c.prevHash !== prevC) errors.push(`${label} : chaînage rompu.`);
    if (chainHash(c.prevHash, closureHashContent(c)) !== c.hash) errors.push(`${label} : contenu modifié.`);
    if (c.keyId === getSigningKey().keyId && !verifyText(c.hash, c.signature)) errors.push(`${label} : signature invalide.`);
    prevC = c.hash;
  });
  return { valid: errors.length === 0, tickets: tickets.length, closures: closures.length, errors };
}

// ─── Archives ───────────────────────────────────────────────────────────────

const NOTICE = (company: Company, register: CashRegister, from: string, to: string, keyId: string) => `ARCHIVE DES DONNÉES D'ENCAISSEMENT
==================================

Entreprise : ${company.legalName}${company.siren ? ` (SIREN ${company.siren})` : ""}
Caisse : ${register.code} — ${register.name}
Période : du ${from} au ${to}
Générée le : ${new Date().toISOString()}

Cette archive est produite en application du 3° bis du I de l'article 286 du CGI
(condition d'archivage, BOI-TVA-DECLA-30-10-30 §220 à 260). Format ouvert : fichiers
texte CSV (séparateur « ; », encodage UTF-8 avec BOM) et JSON.

Fichiers
--------
- tickets.csv     : un ticket par ligne (n°, horodatage UTC, date de rattachement, nature
                    vente/remboursement, ticket d'origine, mode école, totaux HT/TVA/TTC,
                    opérateur, empreinte précédente, empreinte).
- lignes.csv      : détail des articles (libellé, nature, quantité, prix unitaire TTC,
                    taux de TVA, total TTC).
- paiements.csv   : modes de règlement et montants.
- clotures.csv    : clôtures journalières, mensuelles et annuelles (grand total de la
                    période, total perpétuel, cumul des valeurs absolues, empreinte,
                    signature).
- sessions.csv    : ouvertures et fermetures de caisse (fond, espèces attendues et
                    comptées, écart).
- manifeste.json  : liste des fichiers avec leur empreinte SHA-256 et les têtes de chaîne.
- manifeste.sig   : signature Ed25519 (base64) du fichier manifeste.json.
- cle-publique.pem : clé publique permettant de vérifier la signature (identifiant ${keyId}).

Vérification
------------
1. Calculer l'empreinte SHA-256 de chaque fichier et la comparer à manifeste.json.
2. Vérifier la signature de manifeste.json avec cle-publique.pem (algorithme Ed25519),
   par exemple : openssl pkeyutl -verify -pubin -inkey cle-publique.pem -rawin
   -in manifeste.json -sigfile manifeste.bin (après décodage base64 de manifeste.sig).
3. Le chaînage des tickets se vérifie ligne à ligne : l'empreinte précédente de chaque
   ticket est l'empreinte du ticket qui le précède.

Les montants sont exprimés en euros, avec un point comme séparateur décimal.
`;

export async function exportArchive(db: Db, ctx: CompanyContext, registerId: string, from: string, to: string) {
  assertPermission(ctx, "cash.close");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new AppError("VALIDATION", "Période invalide.");
  return db.transaction(async (tx) => {
    const register = await getRegisterRow(tx, ctx, registerId);
    const [company] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
    const tickets = await tx.select().from(cashTickets).where(and(eq(cashTickets.registerId, register.id), gte(cashTickets.businessDate, from), lte(cashTickets.businessDate, to))).orderBy(asc(cashTickets.seq));
    const unclosed = [...new Set(tickets.map((t) => t.businessDate))];
    const closures = await tx.select().from(cashClosures).where(and(eq(cashClosures.registerId, register.id), gte(cashClosures.periodStart, from), lte(cashClosures.periodEnd, to))).orderBy(asc(cashClosures.seq));
    const missing = unclosed.filter((d) => !closures.some((c) => c.kind === "day" && c.periodStart === d));
    if (missing.length) throw new AppError("VALIDATION", `Archivage impossible : journée(s) non clôturée(s) : ${missing.join(", ")}.`);
    const ids = tickets.map((t) => t.id);
    const [lines, pays, sessions] = await Promise.all([
      ids.length ? tx.select().from(cashTicketLines).where(inArray(cashTicketLines.ticketId, ids)).orderBy(asc(cashTicketLines.ticketId), asc(cashTicketLines.position)) : Promise.resolve([]),
      ids.length ? tx.select().from(cashTicketPayments).where(inArray(cashTicketPayments.ticketId, ids)) : Promise.resolve([]),
      tx.select().from(cashSessions).where(and(eq(cashSessions.registerId, register.id), sql`${cashSessions.openedAt}::date between ${from}::date and ${to}::date`)),
    ]);
    const numberOf = new Map(tickets.map((t) => [t.id, t.number]));
    const files: Record<string, string> = {
      "tickets.csv": toCsv(
        ["numero", "rang", "horodatage_utc", "date", "nature", "ticket_origine", "mode_ecole", "total_ht", "total_tva", "total_ttc", "operateur", "motif", "empreinte_precedente", "empreinte"],
        tickets.map((t) => [t.number, t.seq, t.recordedAt.toISOString(), t.businessDate, t.kind === "sale" ? "vente" : "remboursement", t.refundOfId ? numberOf.get(t.refundOfId) ?? t.refundOfId : "", t.training ? "oui" : "non", t.totalExclTax, t.totalVat, t.totalInclTax, t.operatorId, t.reason, t.prevHash, t.hash]),
      ),
      "lignes.csv": toCsv(
        ["ticket", "position", "libelle", "nature", "quantite", "prix_unitaire_ttc", "taux_tva", "total_ttc"],
        lines.map((l) => [numberOf.get(l.ticketId), l.position, l.label, l.kind === "good" ? "bien" : "service", l.quantity, l.unitPriceInclTax, l.vatRate, l.totalInclTax]),
      ),
      "paiements.csv": toCsv(["ticket", "mode", "montant"], pays.map((p) => [numberOf.get(p.ticketId), p.method, p.amount])),
      "clotures.csv": toCsv(
        ["rang", "type", "debut", "fin", "nb_tickets", "total_ht", "total_tva", "grand_total", "total_perpetuel", "cumul_valeurs_absolues", "tva_par_taux", "paiements", "cloture_le", "empreinte_precedente", "empreinte", "signature", "cle"],
        closures.map((c) => [c.seq, c.kind, c.periodStart, c.periodEnd, c.ticketCount, c.totalExclTax, c.totalVat, c.grandTotal, c.perpetualTotal, c.perpetualAbsoluteTotal, JSON.stringify(c.vatBreakdown), JSON.stringify(c.paymentBreakdown), c.closedAt.toISOString(), c.prevHash, c.hash, c.signature, c.keyId]),
      ),
      "sessions.csv": toCsv(
        ["ouverture_utc", "fond_de_caisse", "fermeture_utc", "especes_attendues", "especes_comptees", "ecart", "note"],
        sessions.map((s) => [s.openedAt.toISOString(), s.openingFloat, s.closedAt?.toISOString(), s.expectedCash, s.countedCash, s.difference, s.note]),
      ),
    };
    const key = getSigningKey();
    files["LISEZ-MOI.txt"] = NOTICE(company!, register, from, to, key.keyId);
    const manifest = JSON.stringify(
      {
        entreprise: { raisonSociale: company!.legalName, siren: company!.siren },
        caisse: register.code,
        periode: { debut: from, fin: to },
        tickets: tickets.length,
        premierTicket: tickets[0]?.number ?? null,
        dernierTicket: tickets[tickets.length - 1]?.number ?? null,
        teteChaineTickets: tickets[tickets.length - 1]?.hash ?? null,
        teteChaineClotures: closures[closures.length - 1]?.hash ?? null,
        fichiers: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha(content)])),
        cle: key.keyId,
      },
      null,
      2,
    );
    const { signature, keyId } = signText(manifest);
    const zip = createZip([
      ...Object.entries(files).map(([name, content]) => ({ name, data: Buffer.from(content, "utf8") })),
      { name: "manifeste.json", data: Buffer.from(manifest, "utf8") },
      { name: "manifeste.sig", data: Buffer.from(signature, "utf8") },
      { name: "cle-publique.pem", data: Buffer.from(key.publicKeyPem, "utf8") },
    ]);
    const fileName = `archive-caisse-${register.code}-${from}-${to}.zip`;
    const digest = createHash("sha256").update(zip).digest("hex");
    await tx.insert(cashArchives).values({ companyId: ctx.companyId, registerId: register.id, periodStart: from, periodEnd: to, fileName, sha256: digest, signature, keyId, createdBy: ctx.userId });
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "cash_archive.created",
      entityType: "cash_register",
      entityId: register.id,
      payload: { register: register.code, from, to, fileName, sha256: digest, tickets: tickets.length },
    });
    return { fileName, zip, sha256: digest };
  });
}

/** Vérifie une archive : empreintes des fichiers et signature du manifeste (clé jointe). */
export function verifyArchive(zip: Buffer) {
  const entries = new Map(readZip(zip).map((e) => [e.name, Buffer.from(e.data).toString("utf8")]));
  const manifestText = entries.get("manifeste.json");
  const signature = entries.get("manifeste.sig");
  const publicKey = entries.get("cle-publique.pem");
  if (!manifestText || !signature || !publicKey) return { valid: false, errors: ["Manifeste, signature ou clé absents."] };
  const errors: string[] = [];
  if (!verifyText(manifestText, signature, publicKey)) errors.push("Signature du manifeste invalide.");
  const manifest = JSON.parse(manifestText) as { fichiers: Record<string, string> };
  for (const [name, digest] of Object.entries(manifest.fichiers)) {
    const content = entries.get(name);
    if (content === undefined) errors.push(`Fichier manquant : ${name}.`);
    else if (sha(content) !== digest) errors.push(`Fichier modifié : ${name}.`);
  }
  return { valid: errors.length === 0, errors };
}

export async function listArchives(db: Executor, ctx: CompanyContext, registerId: string) {
  assertPermission(ctx, "cash.operate");
  return db.select().from(cashArchives).where(and(eq(cashArchives.companyId, ctx.companyId), eq(cashArchives.registerId, registerId))).orderBy(desc(cashArchives.createdAt));
}

// ─── Écran de caisse ────────────────────────────────────────────────────────

/** Articles actifs au prix TTC (arrondi au centime), pour la saisie en caisse. */
export async function posCatalog(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "cash.operate");
  const rows = await db
    .select({ id: products.id, reference: products.reference, name: products.name, kind: products.kind, category: products.category, barcode: products.barcode, priceExclTax: products.unitPriceExclTax, rate: vatRates.rate })
    .from(products)
    .innerJoin(vatRates, and(eq(vatRates.id, products.vatRateId), eq(vatRates.companyId, products.companyId)))
    .where(and(eq(products.companyId, ctx.companyId), isNull(products.archivedAt), eq(vatRates.active, true)))
    .orderBy(asc(products.name))
    .limit(1000);
  return rows.map(({ priceExclTax, rate, ...r }) => ({
    ...r,
    vatRate: dec(rate).toFixed(2),
    unitPriceInclTax: roundMoney(dec(priceExclTax).times(new D(100).plus(rate)).dividedBy(100)).toFixed(2),
  }));
}

export async function posVatRates(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "cash.operate");
  const rows = await db.select({ label: vatRates.label, rate: vatRates.rate }).from(vatRates).where(and(eq(vatRates.companyId, ctx.companyId), eq(vatRates.active, true))).orderBy(desc(vatRates.rate));
  return rows.map((r) => ({ label: r.label, rate: dec(r.rate).toFixed(2) }));
}

/** Totaux de la journée en cours (lecture « X », sans clôture). */
export async function dayTotals(db: Executor, ctx: CompanyContext, registerId: string, date: string) {
  assertPermission(ctx, "cash.operate");
  await getRegisterRow(db, ctx, registerId);
  const [totals, methods] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${cashTickets.totalInclTax}), 0)::text` })
      .from(cashTickets)
      .where(and(eq(cashTickets.registerId, registerId), eq(cashTickets.businessDate, date), eq(cashTickets.training, false))),
    db
      .select({ method: cashTicketPayments.method, total: sql<string>`sum(${cashTicketPayments.amount})::text` })
      .from(cashTicketPayments)
      .innerJoin(cashTickets, eq(cashTickets.id, cashTicketPayments.ticketId))
      .where(and(eq(cashTickets.registerId, registerId), eq(cashTickets.businessDate, date), eq(cashTickets.training, false)))
      .groupBy(cashTicketPayments.method),
  ]);
  return { count: totals[0]!.count, total: dec(totals[0]!.total).toFixed(2), byMethod: methods.map((m) => ({ method: m.method, total: dec(m.total).toFixed(2) })) };
}
