import { and, asc, eq, gte, inArray, isNull, like, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor, Tx } from "../db/client";
import { inSequence } from "../db/sequential";
import {
  cashClosures,
  cashTickets,
  expensePayments,
  fiscalYearClosures,
  journalEntries,
  journalLines,
  ledgerAccounts,
  letteringLines,
  letterings,
  paymentAllocations,
  payments,
  salesDocuments,
  thirdParties,
  type JournalLine,
} from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { D, dec, roundMoney, type Dec } from "../domain/money";
import { addDays } from "../domain/sales";
import { fiscalYearOf, todayInParis } from "../domain/numbering";
import { appendAuditEvent } from "./audit";
import { collectedVatAccount, ensureJournal, loadCompany, postEntry } from "./accounting";
import { checkLedger, fiscalYearBounds } from "./accounting-reports";
import { isUuid } from "./third-parties";
import { manualEntrySchema } from "@/lib/schemas";

/**
 * Travaux de fin de période : lettrage des comptes de tiers, clôture d'exercice avec
 * reprise des soldes (à-nouveaux) et aide à la déclaration de TVA.
 */

// ─── Lettrage ───────────────────────────────────────────────────────────────

/** Comptes lettrables : clients (411) et fournisseurs (401). */
export const LETTERABLE_PREFIXES = ["411", "401"] as const;
const isLetterable = (account: string) => LETTERABLE_PREFIXES.some((p) => account.startsWith(p));
const letterableCondition = or(...LETTERABLE_PREFIXES.map((p) => like(journalLines.accountNumber, `${p}%`)))!;

/** 1 → A, 26 → Z, 27 → AA… */
export function letteringCode(n: number): string {
  let code = "";
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) code = String.fromCharCode(65 + ((v - 1) % 26)) + code;
  return code;
}

const lineBalance = (lines: Pick<JournalLine, "debit" | "credit">[]) => lines.reduce((a, l) => a.plus(l.debit).minus(l.credit), new D(0));

async function lockLettering(tx: Tx, companyId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"lettering:" + companyId}))`);
}

async function createLettering(tx: Tx, ctx: CompanyContext, lines: JournalLine[], method: "auto" | "manual", now: Date) {
  const account = lines[0]!.accountNumber;
  const aux = lines[0]!.auxNumber;
  // Codes attribués dans l'ordre, par compte, jamais réutilisés (même après délettrage).
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(letterings)
    .where(and(eq(letterings.companyId, ctx.companyId), eq(letterings.accountNumber, account)));
  const [group] = await tx
    .insert(letterings)
    .values({ companyId: ctx.companyId, accountNumber: account, auxNumber: aux, code: letteringCode(n + 1), method, letteredAt: now, letteredBy: ctx.userId })
    .returning();
  await tx.insert(letteringLines).values(lines.map((l) => ({ companyId: ctx.companyId, letteringId: group!.id, lineId: l.id })));
  return group!;
}

async function unletteredLines(tx: Executor, companyId: string, extra: SQL[] = []) {
  return tx
    .select({ line: journalLines, sourceKey: journalEntries.sourceKey, fiscalYear: journalEntries.fiscalYear })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .leftJoin(letteringLines, eq(letteringLines.lineId, journalLines.id))
    .where(and(eq(journalLines.companyId, companyId), letterableCondition, isNull(letteringLines.lineId), ...extra));
}

const lineIdsSchema = z.array(z.uuid()).min(2, "Sélectionnez au moins deux lignes.").max(500);

export async function letterLines(db: Db, ctx: CompanyContext, rawIds: unknown, opts: { now?: Date } = {}) {
  assertPermission(ctx, "accounting.write");
  const ids = [...new Set(lineIdsSchema.parse(rawIds))];
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    await lockLettering(tx, ctx.companyId);
    const found = await unletteredLines(tx, ctx.companyId, [inArray(journalLines.id, ids)]);
    const rows = found.map((r) => r.line);
    if (rows.length !== ids.length) throw new AppError("VALIDATION", "Certaines lignes sont introuvables, déjà lettrées ou sur un compte non lettrable.");
    const first = rows[0]!;
    if (rows.some((l) => l.accountNumber !== first.accountNumber || l.auxNumber !== first.auxNumber)) {
      throw new AppError("VALIDATION", "Les lignes doivent appartenir au même compte et au même tiers.");
    }
    if (new Set(found.map((r) => r.fiscalYear)).size > 1) {
      throw new AppError("VALIDATION", "Les lignes doivent appartenir au même exercice (après clôture, lettrez avec l'écriture d'à-nouveaux).");
    }
    const balance = lineBalance(rows);
    if (!balance.isZero()) throw new AppError("VALIDATION", `Lettrage impossible : le solde des lignes sélectionnées est de ${balance.toFixed(2).replace(".", ",")} €, il doit être nul.`);
    const group = await createLettering(tx, ctx, rows, "manual", now);
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "accounting.lettered",
      entityType: "lettering",
      entityId: group.id,
      payload: { account: group.accountNumber, aux: group.auxNumber, code: group.code, lines: rows.length },
    });
    return group;
  });
}

export async function unletter(db: Db, ctx: CompanyContext, letteringId: string, opts: { now?: Date } = {}) {
  assertPermission(ctx, "accounting.write");
  if (!isUuid(letteringId)) throw notFound("Lettrage introuvable.");
  return db.transaction(async (tx) => {
    await lockLettering(tx, ctx.companyId);
    const [group] = await tx.select().from(letterings).where(and(eq(letterings.companyId, ctx.companyId), eq(letterings.id, letteringId))).limit(1);
    if (!group || group.unletteredAt) throw notFound("Lettrage introuvable.");
    const links = await tx.select({ lineId: letteringLines.lineId }).from(letteringLines).where(eq(letteringLines.letteringId, group.id));
    await tx.update(letterings).set({ unletteredAt: opts.now ?? new Date(), unletteredBy: ctx.userId }).where(eq(letterings.id, group.id));
    await tx.delete(letteringLines).where(eq(letteringLines.letteringId, group.id));
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "accounting.unlettered",
      entityType: "lettering",
      entityId: group.id,
      payload: { account: group.accountNumber, aux: group.auxNumber, code: group.code, lines: links.map((l) => l.lineId).join(",") },
    });
  });
}

/**
 * Lettrage automatique des comptes 411 / 401 :
 *  0. chaque contre-passation avec le règlement qu'elle annule ;
 *  1. groupes reliés par les pièces (facture ↔ règlements imputés, avoir ↔ facture d'origine,
 *     contre-passation ↔ règlement, dépense ↔ paiements) dont le solde est nul ;
 *  2. puis, par tiers, l'ensemble des lignes restantes si leur solde est nul.
 * Toujours au sein d'un même exercice.
 */
export async function autoLetter(db: Db, ctx: CompanyContext, opts: { now?: Date } = {}) {
  assertPermission(ctx, "accounting.write");
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    await lockLettering(tx, ctx.companyId);
    const open = await unletteredLines(tx, ctx.companyId);
    if (open.length === 0) return { created: 0 };

    // Union-find sur les origines d'écritures (« sales:<id> », « payment:<id> »…).
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      const p = parent.get(k) ?? k;
      if (p === k) return k;
      const root = find(p);
      parent.set(k, root);
      return root;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));
    const [allocs, reversals, creditNotes, expPays] = await inSequence([
      tx.select({ p: paymentAllocations.paymentId, d: paymentAllocations.documentId }).from(paymentAllocations).where(eq(paymentAllocations.companyId, ctx.companyId)),
      tx.select({ id: payments.id, of: payments.reversesPaymentId }).from(payments).where(and(eq(payments.companyId, ctx.companyId), sql`${payments.reversesPaymentId} is not null`)),
      tx.select({ id: salesDocuments.id, of: salesDocuments.sourceDocumentId }).from(salesDocuments).where(and(eq(salesDocuments.companyId, ctx.companyId), eq(salesDocuments.type, "credit_note"), ne(salesDocuments.status, "draft"))),
      tx.select({ id: expensePayments.id, expense: expensePayments.expenseId, of: expensePayments.reversesId }).from(expensePayments).where(eq(expensePayments.companyId, ctx.companyId)),
    ]);
    for (const a of allocs) union(`payment:${a.p}`, `sales:${a.d}`);
    for (const r of reversals) union(`payment:${r.id}`, `payment:${r.of}`);
    for (const c of creditNotes) if (c.of) union(`sales:${c.id}`, `sales:${c.of}`);
    for (const e of expPays) {
      union(`expense_payment:${e.id}`, `expense:${e.expense}`);
      if (e.of) union(`expense_payment:${e.id}`, `expense_payment:${e.of}`);
    }

    let created = 0;
    const done = new Set<string>();
    // 0. Une contre-passation se lettre avec le règlement qu'elle annule.
    const pairs = [
      ...reversals.map((r) => [`payment:${r.of}`, `payment:${r.id}`]),
      ...expPays.filter((e) => e.of).map((e) => [`expense_payment:${e.of}`, `expense_payment:${e.id}`]),
    ];
    for (const [a, b] of pairs) {
      const pair = open.filter((o) => o.sourceKey === a || o.sourceKey === b);
      const lines = pair.map((p) => p.line);
      if (
        lines.length === 2 &&
        new Set(pair.map((p) => `${p.fiscalYear}|${p.line.accountNumber}|${p.line.auxNumber ?? ""}`)).size === 1 &&
        lineBalance(lines).isZero()
      ) {
        await createLettering(tx, ctx, lines, "auto", now);
        lines.forEach((l) => done.add(l.id));
        created++;
      }
    }

    const groups = new Map<string, JournalLine[]>();
    // Jamais d'un exercice à l'autre : le solde d'un exercice clos est repris par l'à-nouveau.
    for (const { line, sourceKey, fiscalYear } of open) {
      if (done.has(line.id)) continue;
      const key = `${fiscalYear}|${line.accountNumber}|${line.auxNumber ?? ""}|${find(sourceKey)}`;
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
    for (const lines of groups.values()) {
      if (lines.length >= 2 && lineBalance(lines).isZero()) {
        await createLettering(tx, ctx, lines, "auto", now);
        lines.forEach((l) => done.add(l.id));
        created++;
      }
    }
    const byParty = new Map<string, JournalLine[]>();
    for (const { line, fiscalYear } of open) {
      if (done.has(line.id)) continue;
      const key = `${fiscalYear}|${line.accountNumber}|${line.auxNumber ?? ""}`;
      byParty.set(key, [...(byParty.get(key) ?? []), line]);
    }
    for (const lines of byParty.values()) {
      if (lines.length >= 2 && lineBalance(lines).isZero()) {
        await createLettering(tx, ctx, lines, "auto", now);
        created++;
      }
    }
    if (created) {
      await appendAuditEvent(tx, {
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: "accounting.auto_lettered",
        entityType: "lettering",
        entityId: ctx.companyId,
        payload: { groups: created },
      });
    }
    return { created };
  });
}

/** Comptes de tiers avec leur solde non lettré. */
export async function letteringAccounts(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "accounting.read");
  return db
    .select({
      account: journalLines.accountNumber,
      aux: journalLines.auxNumber,
      auxLabel: sql<string>`max(${journalLines.auxLabel})`,
      open: sql<number>`count(*) filter (where ${letteringLines.lineId} is null)::int`,
      openBalance: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}) filter (where ${letteringLines.lineId} is null), 0)::text`,
    })
    .from(journalLines)
    .leftJoin(letteringLines, eq(letteringLines.lineId, journalLines.id))
    .where(and(eq(journalLines.companyId, ctx.companyId), letterableCondition))
    .groupBy(journalLines.accountNumber, journalLines.auxNumber)
    .orderBy(asc(journalLines.accountNumber), asc(journalLines.auxNumber));
}

/** Lignes d'un compte de tiers, avec leur lettrage éventuel. */
export async function letteringLinesOf(db: Executor, ctx: CompanyContext, account: string, aux: string | null) {
  assertPermission(ctx, "accounting.read");
  if (!isLetterable(account)) throw new AppError("VALIDATION", "Compte non lettrable.");
  return db
    .select({
      id: journalLines.id,
      entryDate: journalEntries.entryDate,
      journalCode: journalEntries.journalCode,
      entrySeq: journalEntries.entrySeq,
      fiscalYear: journalEntries.fiscalYear,
      pieceRef: journalEntries.pieceRef,
      label: journalLines.label,
      debit: journalLines.debit,
      credit: journalLines.credit,
      letteringId: letterings.id,
      code: letterings.code,
      letteredAt: letterings.letteredAt,
      method: letterings.method,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .leftJoin(letteringLines, eq(letteringLines.lineId, journalLines.id))
    .leftJoin(letterings, eq(letterings.id, letteringLines.letteringId))
    .where(and(eq(journalLines.companyId, ctx.companyId), eq(journalLines.accountNumber, account), aux ? eq(journalLines.auxNumber, aux) : isNull(journalLines.auxNumber)))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entrySeq), asc(journalLines.lineNo))
    .limit(2000);
}

// ─── Clôture d'exercice ─────────────────────────────────────────────────────

export interface ClosingCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

async function closingState(tx: Executor, ctx: CompanyContext, fiscalYear: number, now: Date) {
  const company = await loadCompany(tx, ctx.companyId);
  const { from, to } = fiscalYearBounds(company, fiscalYear);
  const today = todayInParis(now);
  const [[closed], [earlier], ledger, [unclosedCash], [{ count } = { count: 0 }]] = await inSequence([
    tx.select().from(fiscalYearClosures).where(and(eq(fiscalYearClosures.companyId, ctx.companyId), eq(fiscalYearClosures.fiscalYear, fiscalYear))).limit(1),
    tx
      .select({ year: journalEntries.fiscalYear })
      .from(journalEntries)
      .leftJoin(fiscalYearClosures, and(eq(fiscalYearClosures.companyId, journalEntries.companyId), eq(fiscalYearClosures.fiscalYear, journalEntries.fiscalYear)))
      .where(and(eq(journalEntries.companyId, ctx.companyId), lt(journalEntries.fiscalYear, fiscalYear), isNull(fiscalYearClosures.id)))
      .limit(1),
    () => checkLedger(tx, ctx, fiscalYear),
    tx
      .select({ date: cashTickets.businessDate })
      .from(cashTickets)
      .leftJoin(cashClosures, and(eq(cashClosures.registerId, cashTickets.registerId), eq(cashClosures.kind, "day"), eq(cashClosures.periodStart, cashTickets.businessDate)))
      .where(and(eq(cashTickets.companyId, ctx.companyId), gte(cashTickets.businessDate, from), lte(cashTickets.businessDate, to), isNull(cashClosures.id)))
      .limit(1),
    tx.select({ count: sql<number>`count(*)::int` }).from(journalEntries).where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.fiscalYear, fiscalYear))),
  ]);
  const checks: ClosingCheck[] = [
    { label: "Exercice terminé", ok: to < today, detail: to < today ? undefined : `L'exercice se termine le ${to.split("-").reverse().join("/")}.` },
    { label: "Exercices antérieurs clôturés", ok: !earlier, detail: earlier ? `Clôturez d'abord l'exercice ${earlier.year}.` : undefined },
    { label: "Écritures équilibrées", ok: ledger.balanced },
    { label: "Numérotation continue", ok: ledger.continuous },
    { label: "Journées de caisse clôturées", ok: !unclosedCash, detail: unclosedCash ? `Journée du ${unclosedCash.date.split("-").reverse().join("/")} non clôturée.` : undefined },
  ];
  return { company, from, to, closed: closed ?? null, checks, entryCount: count };
}

/** Soldes par compte (et compte auxiliaire) d'un exercice. */
async function yearBalances(tx: Executor, companyId: string, fiscalYear: number) {
  return tx
    .select({
      account: journalLines.accountNumber,
      aux: journalLines.auxNumber,
      auxLabel: sql<string | null>`max(${journalLines.auxLabel})`,
      debit: sql<string>`sum(${journalLines.debit})::text`,
      credit: sql<string>`sum(${journalLines.credit})::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.fiscalYear, fiscalYear)))
    .groupBy(journalLines.accountNumber, journalLines.auxNumber)
    .orderBy(asc(journalLines.accountNumber), asc(journalLines.auxNumber));
}

function resultOf(balances: { account: string; debit: string; credit: string }[]) {
  // Produits (classe 7) − charges (classe 6) = Σ (crédit − débit) des classes 6 et 7.
  return balances.filter((b) => /^[67]/.test(b.account)).reduce((a, b) => a.plus(b.credit).minus(b.debit), new D(0));
}

export async function fiscalYearClosingPreview(db: Executor, ctx: CompanyContext, fiscalYear: number, opts: { now?: Date } = {}) {
  assertPermission(ctx, "accounting.read");
  const state = await closingState(db, ctx, fiscalYear, opts.now ?? new Date());
  const balances = await yearBalances(db, ctx.companyId, fiscalYear);
  const result = resultOf(balances);
  return {
    fiscalYear,
    from: state.from,
    to: state.to,
    closure: state.closed,
    checks: state.checks,
    entryCount: state.entryCount,
    result: result.toFixed(2),
    canClose: !state.closed && state.checks.every((c) => c.ok),
  };
}

/**
 * Clôture définitive d'un exercice : contrôles, calcul du résultat, écriture d'à-nouveaux
 * (journal AN) au premier jour de l'exercice suivant — comptes de bilan (classes 1 à 5)
 * repris par tiers, résultat en 120000 (bénéfice) ou 129000 (perte), en attente d'affectation.
 * Ensuite, aucune écriture ne peut plus être enregistrée sur l'exercice (contrôlé en base).
 */
export async function closeFiscalYear(db: Db, ctx: CompanyContext, fiscalYear: number, opts: { now?: Date } = {}) {
  assertPermission(ctx, "accounting.close");
  if (!Number.isInteger(fiscalYear)) throw new AppError("VALIDATION", "Exercice invalide.");
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"fiscal-close:" + ctx.companyId}))`);
    const state = await closingState(tx, ctx, fiscalYear, now);
    if (state.closed) throw new AppError("CONFLICT", `L'exercice ${fiscalYear} est déjà clôturé.`);
    const failed = state.checks.filter((c) => !c.ok);
    if (failed.length) throw new AppError("VALIDATION", `Clôture impossible : ${failed.map((c) => c.detail ?? c.label).join(" ")}`);

    const balances = await yearBalances(tx, ctx.companyId, fiscalYear);
    const result = resultOf(balances);
    const totalDebit = balances.reduce((a, b) => a.plus(b.debit), new D(0));
    const totalCredit = balances.reduce((a, b) => a.plus(b.credit), new D(0));
    const opening = addDays(state.to, 1);
    const label = `À-nouveaux de l'exercice ${fiscalYear}`;
    const lines: { account: string; amount: Dec; label: string; aux?: { number: string; label: string } }[] = balances
      .filter((b) => /^[1-5]/.test(b.account))
      .map((b) => ({
        account: b.account,
        amount: roundMoney(dec(b.debit).minus(b.credit)),
        label,
        aux: b.aux ? { number: b.aux, label: b.auxLabel ?? b.aux } : undefined,
      }));
    if (!result.isZero()) lines.push({ account: result.isNegative() ? "129000" : "120000", amount: result.negated(), label });
    await ensureJournal(tx, ctx.companyId, "AN");
    const openingEntryId = await postEntry(
      tx,
      state.company,
      { journalCode: "AN", entryDate: opening, pieceRef: `AN-${fiscalYear}`, pieceDate: state.to, label, sourceKey: `opening:${fiscalYear}`, lines },
      now,
    );
    const [closure] = await tx
      .insert(fiscalYearClosures)
      .values({
        companyId: ctx.companyId,
        fiscalYear,
        periodStart: state.from,
        periodEnd: state.to,
        result: result.toFixed(2),
        totalDebit: totalDebit.toFixed(2),
        totalCredit: totalCredit.toFixed(2),
        entryCount: state.entryCount,
        openingEntryId,
        closedAt: now,
        closedBy: ctx.userId,
      })
      .returning();
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "accounting.fiscal_year_closed",
      entityType: "fiscal_year",
      entityId: String(fiscalYear),
      payload: { from: state.from, to: state.to, result: result.toFixed(2), entries: state.entryCount, totalDebit: totalDebit.toFixed(2) },
    });
    return closure!;
  });
}

/** Exercices connus : ceux ayant des écritures, l'exercice en cours, et leur état. */
export async function listFiscalYears(db: Executor, ctx: CompanyContext, opts: { now?: Date } = {}) {
  assertPermission(ctx, "accounting.read");
  const company = await loadCompany(db, ctx.companyId);
  const [years, closures] = await Promise.all([
    db.selectDistinct({ year: journalEntries.fiscalYear }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId)),
    db.select().from(fiscalYearClosures).where(eq(fiscalYearClosures.companyId, ctx.companyId)),
  ]);
  const current = fiscalYearOf(todayInParis(opts.now), company.fiscalYearStartMonth);
  const all = [...new Set([current, ...years.map((y) => y.year)])].sort((a, b) => b - a);
  return all.map((year) => ({ year, ...fiscalYearBounds(company, year), closure: closures.find((c) => c.fiscalYear === year) ?? null }));
}

// ─── Aide à la déclaration de TVA ───────────────────────────────────────────

const KNOWN_RATES = ["20.00", "10.00", "5.50", "2.10"];

/**
 * Montants de TVA d'une période, tirés des écritures (hors à-nouveaux) :
 *  - TVA collectée exigible (comptes 44571x, y compris la TVA sur encaissements devenue
 *    exigible lors du règlement) ; base HT reconstituée à partir du taux ;
 *  - TVA déductible sur biens et services (445660) et sur immobilisations (445620) ;
 *  - TVA collectée en attente (44574x) : non exigible, rappelée pour information.
 * Ce document est une aide : il ne constitue pas une déclaration et doit être rapproché
 * du formulaire en vigueur (notice 3310-CA3) par l'utilisateur ou son expert-comptable.
 */
export async function vatSummary(db: Executor, ctx: CompanyContext, from: string, to: string) {
  assertPermission(ctx, "accounting.read");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new AppError("VALIDATION", "Période invalide.");
  const movements = await db
    .select({ account: journalLines.accountNumber, debit: sql<string>`sum(${journalLines.debit})::text`, credit: sql<string>`sum(${journalLines.credit})::text` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        ne(journalEntries.journalCode, "AN"),
        gte(journalEntries.entryDate, from),
        lte(journalEntries.entryDate, to),
        or(like(journalLines.accountNumber, "4456%"), like(journalLines.accountNumber, "4457%")),
      ),
    )
    .groupBy(journalLines.accountNumber);
  const [pending] = await db
    .select({ balance: sql<string>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}), 0)::text` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalEntries.companyId, ctx.companyId), lte(journalEntries.entryDate, to), like(journalLines.accountNumber, "44574%")));

  const net = (account: string, side: "credit" | "debit") => {
    const m = movements.find((x) => x.account === account);
    if (!m) return new D(0);
    return side === "credit" ? dec(m.credit).minus(m.debit) : dec(m.debit).minus(m.credit);
  };
  const collected = KNOWN_RATES.map((rate) => {
    const vat = net(collectedVatAccount(rate), "credit");
    return { rate, account: collectedVatAccount(rate), vat: vat.toFixed(2), base: roundMoney(vat.times(100).dividedBy(rate)).toFixed(2) };
  }).filter((c) => !dec(c.vat).isZero());
  const otherCollected = movements
    .filter((m) => m.account.startsWith("44571") && !KNOWN_RATES.some((r) => collectedVatAccount(r) === m.account))
    .reduce((a, m) => a.plus(m.credit).minus(m.debit), new D(0));
  const deductibleGoods = net("445660", "debit");
  const deductibleAssets = net("445620", "debit");
  const otherDeductible = movements
    .filter((m) => m.account.startsWith("4456") && !["445660", "445620"].includes(m.account))
    .reduce((a, m) => a.plus(m.debit).minus(m.credit), new D(0));
  const totalCollected = collected.reduce((a, c) => a.plus(c.vat), otherCollected);
  const totalDeductible = deductibleGoods.plus(deductibleAssets).plus(otherDeductible);
  const balance = totalCollected.minus(totalDeductible);
  return {
    from,
    to,
    collected,
    otherCollected: otherCollected.toFixed(2),
    totalCollected: totalCollected.toFixed(2),
    deductibleGoods: deductibleGoods.toFixed(2),
    deductibleAssets: deductibleAssets.toFixed(2),
    otherDeductible: otherDeductible.toFixed(2),
    totalDeductible: totalDeductible.toFixed(2),
    /** Positif : TVA à payer ; négatif : crédit de TVA. */
    balance: balance.toFixed(2),
    pendingAtEnd: dec(pending!.balance).toFixed(2),
  };
}

// ─── Saisie d'opérations diverses ───────────────────────────────────────────

/**
 * Écriture saisie manuellement (journal OD) : écritures d'inventaire, corrections,
 * affectation du résultat… Équilibrée, validée dès l'enregistrement (pas de brouillard),
 * idempotente (clé de formulaire), refusée sur un exercice clôturé ; tracée à l'audit.
 */
export async function postManualEntry(db: Db, ctx: CompanyContext, raw: unknown, opts: { now?: Date } = {}) {
  assertPermission(ctx, "accounting.write");
  const data = manualEntrySchema.parse(raw);
  const now = opts.now ?? new Date();
  if (data.entryDate > todayInParis(now)) throw new AppError("VALIDATION", "La date de l'écriture ne peut pas être postérieure à aujourd'hui.");
  const lines = data.lines.map((l, i) => {
    const debit = dec(l.debit || "0");
    const credit = dec(l.credit || "0");
    if (debit.isZero() === credit.isZero()) throw new AppError("VALIDATION", `Ligne ${i + 1} : indiquez soit un débit, soit un crédit.`);
    return { ...l, amount: debit.minus(credit) };
  });
  const debit = lines.reduce((a, l) => (l.amount.isPositive() ? a.plus(l.amount) : a), new D(0));
  const credit = lines.reduce((a, l) => (l.amount.isNegative() ? a.minus(l.amount) : a), new D(0));
  if (!debit.equals(credit)) {
    throw new AppError("VALIDATION", `Écriture déséquilibrée : débit ${debit.toFixed(2).replace(".", ",")} €, crédit ${credit.toFixed(2).replace(".", ",")} €.`);
  }
  return db.transaction(async (tx) => {
    const company = await loadCompany(tx, ctx.companyId);
    const codes = [...new Set(lines.map((l) => l.auxNumber).filter((v): v is string => !!v))];
    const parties = codes.length
      ? await tx.select({ code: thirdParties.code, name: thirdParties.name }).from(thirdParties).where(and(eq(thirdParties.companyId, ctx.companyId), inArray(thirdParties.code, codes)))
      : [];
    const missing = codes.filter((c) => !parties.some((p) => p.code === c));
    if (missing.length) throw new AppError("VALIDATION", `Compte auxiliaire inconnu : ${missing.join(", ")}.`);
    const known = await tx.select({ number: ledgerAccounts.number }).from(ledgerAccounts).where(and(eq(ledgerAccounts.companyId, ctx.companyId), inArray(ledgerAccounts.number, lines.map((l) => l.account))));
    const unknown = lines.filter((l) => !l.accountLabel && !known.some((k) => k.number === l.account));
    if (unknown.length) throw new AppError("VALIDATION", `Compte ${unknown[0]!.account} absent du plan : indiquez son intitulé pour le créer.`);
    const sourceKey = `manual:${data.idempotencyKey}`;
    const [existing] = await tx.select({ id: journalEntries.id }).from(journalEntries).where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceKey, sourceKey))).limit(1);
    if (existing) return { id: existing.id, replayed: true };
    await ensureJournal(tx, ctx.companyId, "OD");
    const id = await postEntry(
      tx,
      company,
      {
        journalCode: "OD",
        entryDate: data.entryDate,
        pieceRef: data.pieceRef,
        pieceDate: data.entryDate,
        label: data.label,
        sourceKey,
        lines: lines.map((l) => ({
          account: l.account,
          accountLabel: l.accountLabel ?? undefined,
          amount: l.amount,
          label: l.label || data.label,
          aux: l.auxNumber ? { number: l.auxNumber, label: parties.find((p) => p.code === l.auxNumber)!.name } : undefined,
        })),
      },
      now,
    );
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "accounting.manual_entry",
      entityType: "journal_entry",
      entityId: id!,
      payload: { date: data.entryDate, piece: data.pieceRef, label: data.label, amount: debit.toFixed(2), lines: lines.length },
    });
    return { id: id!, replayed: false };
  });
}

export async function listLedgerAccounts(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "accounting.read");
  return db.select({ number: ledgerAccounts.number, label: ledgerAccounts.label }).from(ledgerAccounts).where(eq(ledgerAccounts.companyId, ctx.companyId)).orderBy(asc(ledgerAccounts.number));
}

/** Comptes auxiliaires (tiers) proposés à la saisie. */
export async function auxiliaryAccounts(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "accounting.read");
  return db.select({ code: thirdParties.code, name: thirdParties.name }).from(thirdParties).where(eq(thirdParties.companyId, ctx.companyId)).orderBy(asc(thirdParties.code)).limit(2000);
}
