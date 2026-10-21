import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../db/client";
import { companies, expenses, journalEntries, journalLines, journals, ledgerAccounts, letteringLines, letterings, salesDocuments, thirdParties, type Company } from "../db/schema";
import { AppError } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { D, dec } from "../domain/money";
import { fiscalYearOf, todayInParis } from "../domain/numbering";

import { invoiceBalances } from "./payments";
import { PAGE_SIZE } from "./listing";

/**
 * Restitutions comptables : journal, grand livre, balance, échéancier, FEC.
 * Lecture seule ; toutes les requêtes sont limitées à l'entreprise du contexte.
 */

/** Bornes d'un exercice désigné par l'année de sa clôture. */
export function fiscalYearBounds(company: Pick<Company, "fiscalYearStartMonth">, fiscalYear: number) {
  const m = company.fiscalYearStartMonth;
  const startYear = m === 1 ? fiscalYear : fiscalYear - 1;
  const from = `${startYear}-${String(m).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(startYear + 1, m - 1, 0)); // dernier jour du mois précédant le début
  return { from, to: end.toISOString().slice(0, 10) };
}

async function company(db: Executor, ctx: CompanyContext) {
  const [c] = await db.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return c!;
}

export async function currentFiscalYear(db: Executor, ctx: CompanyContext, now?: Date) {
  return fiscalYearOf(todayInParis(now), (await company(db, ctx)).fiscalYearStartMonth);
}

export async function listJournals(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "accounting.read");
  return db.select().from(journals).where(eq(journals.companyId, ctx.companyId)).orderBy(asc(journals.code));
}

export async function listEntries(
  db: Executor,
  ctx: CompanyContext,
  f: { fiscalYear: number; journalCode?: string; page: number },
) {
  assertPermission(ctx, "accounting.read");
  const conditions: SQL[] = [eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.fiscalYear, f.fiscalYear)];
  if (f.journalCode) conditions.push(eq(journalEntries.journalCode, f.journalCode));
  const where = and(...conditions);
  const [entries, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select()
      .from(journalEntries)
      .where(where)
      .orderBy(desc(journalEntries.entrySeq))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(journalEntries).where(where),
  ]);
  const lines = entries.length
    ? await db
        .select()
        .from(journalLines)
        .where(inArray(journalLines.entryId, entries.map((e) => e.id)))
        .orderBy(asc(journalLines.lineNo))
    : [];
  return { rows: entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entryId === e.id) })), total, pageSize: PAGE_SIZE };
}

/** Balance générale d'une période (soldes par compte). */
export async function trialBalance(db: Executor, ctx: CompanyContext, from: string, to: string) {
  assertPermission(ctx, "accounting.read");
  const rows = await db
    .select({
      account: journalLines.accountNumber,
      label: ledgerAccounts.label,
      debit: sql<string>`sum(${journalLines.debit})::text`,
      credit: sql<string>`sum(${journalLines.credit})::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(ledgerAccounts, and(eq(ledgerAccounts.companyId, journalLines.companyId), eq(ledgerAccounts.number, journalLines.accountNumber)))
    .where(and(eq(journalLines.companyId, ctx.companyId), gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to)))
    .groupBy(journalLines.accountNumber, ledgerAccounts.label)
    .orderBy(asc(journalLines.accountNumber));
  const accounts = rows.map((r) => {
    const balance = dec(r.debit).minus(r.credit);
    return {
      account: r.account,
      label: r.label,
      debit: dec(r.debit).toFixed(2),
      credit: dec(r.credit).toFixed(2),
      debitBalance: balance.isPositive() ? balance.toFixed(2) : "0.00",
      creditBalance: balance.isNegative() ? balance.negated().toFixed(2) : "0.00",
    };
  });
  const sum = (k: "debit" | "credit" | "debitBalance" | "creditBalance") => accounts.reduce((a, r) => a.plus(r[k]), new D(0)).toFixed(2);
  return { accounts, totals: { debit: sum("debit"), credit: sum("credit"), debitBalance: sum("debitBalance"), creditBalance: sum("creditBalance") } };
}

/** Grand livre d'un compte : solde d'ouverture, mouvements, solde progressif. */
export async function generalLedger(db: Executor, ctx: CompanyContext, account: string, from: string, to: string) {
  assertPermission(ctx, "accounting.read");
  if (!/^[1-7]\d{2,7}$/.test(account)) throw new AppError("VALIDATION", "Numéro de compte invalide.");
  const base = and(eq(journalLines.companyId, ctx.companyId), eq(journalLines.accountNumber, account));
  const [[opening], lines, [meta]] = await Promise.all([
    db
      .select({ balance: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::text` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(base, lt(journalEntries.entryDate, from))),
    db
      .select({
        entrySeq: journalEntries.entrySeq,
        fiscalYear: journalEntries.fiscalYear,
        journalCode: journalEntries.journalCode,
        entryDate: journalEntries.entryDate,
        pieceRef: journalEntries.pieceRef,
        label: journalLines.label,
        auxNumber: journalLines.auxNumber,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(base, gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to)))
      .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entrySeq), asc(journalLines.lineNo))
      .limit(2000),
    db.select({ label: ledgerAccounts.label }).from(ledgerAccounts).where(and(eq(ledgerAccounts.companyId, ctx.companyId), eq(ledgerAccounts.number, account))),
  ]);
  let running = dec(opening!.balance);
  const rows = lines.map((l) => {
    running = running.plus(l.debit).minus(l.credit);
    return { ...l, balance: running.toFixed(2) };
  });
  return { account, label: meta?.label ?? null, opening: dec(opening!.balance).toFixed(2), rows, closing: running.toFixed(2) };
}

const BUCKETS = [
  { key: "not_due", label: "Non échu" },
  { key: "d30", label: "1 à 30 j" },
  { key: "d60", label: "31 à 60 j" },
  { key: "d90", label: "61 à 90 j" },
  { key: "over90", label: "Plus de 90 j" },
] as const;
type Bucket = (typeof BUCKETS)[number]["key"];

function bucketOf(dueDate: string | null, today: string): Bucket {
  if (!dueDate || dueDate >= today) return "not_due";
  const days = Math.round((Date.parse(today) - Date.parse(dueDate)) / 86_400_000);
  return days <= 30 ? "d30" : days <= 60 ? "d60" : days <= 90 ? "d90" : "over90";
}

/** Échéancier : créances clients et dettes fournisseurs par ancienneté de retard. */
export async function agedBalances(db: Executor, ctx: CompanyContext, now?: Date) {
  assertPermission(ctx, "accounting.read");
  const today = todayInParis(now);
  const empty = () => Object.fromEntries(BUCKETS.map((b) => [b.key, new D(0)])) as Record<Bucket, InstanceType<typeof D>>;
  const group = (items: { party: string; amount: string; dueDate: string | null }[]) => {
    const byParty = new Map<string, Record<Bucket, InstanceType<typeof D>>>();
    for (const it of items) {
      const row = byParty.get(it.party) ?? empty();
      const b = bucketOf(it.dueDate, today);
      row[b] = row[b].plus(it.amount);
      byParty.set(it.party, row);
    }
    const rows = [...byParty.entries()]
      .map(([party, r]) => ({
        party,
        buckets: Object.fromEntries(BUCKETS.map((b) => [b.key, r[b.key].toFixed(2)])) as Record<Bucket, string>,
        total: BUCKETS.reduce((a, b) => a.plus(r[b.key]), new D(0)).toFixed(2),
      }))
      .sort((a, b) => dec(b.total).comparedTo(a.total));
    const totals = Object.fromEntries(BUCKETS.map((b) => [b.key, rows.reduce((a, r) => a.plus(r.buckets[b.key]), new D(0)).toFixed(2)])) as Record<Bucket, string>;
    return { rows, totals, total: rows.reduce((a, r) => a.plus(r.total), new D(0)).toFixed(2) };
  };

  const balances = (await invoiceBalances(db, ctx, {}, now)).filter((b) => dec(b.remaining).greaterThan(0));
  const invoiceParties = balances.length
    ? await db
        .select({ id: salesDocuments.id, name: thirdParties.name })
        .from(salesDocuments)
        .innerJoin(thirdParties, and(eq(thirdParties.id, salesDocuments.thirdPartyId), eq(thirdParties.companyId, salesDocuments.companyId)))
        .where(and(eq(salesDocuments.companyId, ctx.companyId), inArray(salesDocuments.id, balances.map((b) => b.id))))
    : [];
  const receivables = group(
    balances.map((b) => ({ party: invoiceParties.find((p) => p.id === b.id)?.name ?? "—", amount: b.remaining, dueDate: b.dueDate })),
  );
  const payablesRows = await db
    .select({ party: thirdParties.name, amount: sql<string>`(${expenses.totalInclTax} - ${expenses.amountPaid})::text`, dueDate: expenses.dueDate })
    .from(expenses)
    .innerJoin(thirdParties, and(eq(thirdParties.id, expenses.thirdPartyId), eq(thirdParties.companyId, expenses.companyId)))
    .where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.status, "validated"), sql`${expenses.totalInclTax} > ${expenses.amountPaid}`));
  return { today, buckets: BUCKETS, receivables, payables: group(payablesRows) };
}

// ─── FEC ────────────────────────────────────────────────────────────────────

export const FEC_HEADERS = [
  "JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib", "CompAuxNum", "CompAuxLib", "PieceRef",
  "PieceDate", "EcritureLib", "Debit", "Credit", "EcritureLet", "DateLet", "ValidDate", "Montantdevise", "Idevise",
] as const;

const fecDate = (iso: string) => iso.replaceAll("-", "");
const fecAmount = (v: string) => dec(v).toFixed(2).replace(".", ",");
/** Aucune tabulation ni fin de ligne dans une zone (le séparateur doit rester non équivoque). */
const fecText = (v: string | null | undefined) => (v ?? "").replace(/[\t\r\n]+/g, " ").trim();

/**
 * Fichier des écritures comptables (LPF art. A. 47 A-1) pour un exercice.
 * Format : voir docs/13-fec-descriptif.md (tabulation, UTF-8, dates AAAAMMJJ, virgule décimale).
 */
export async function exportFec(db: Executor, ctx: CompanyContext, fiscalYear: number) {
  assertPermission(ctx, "exports.run");
  const c = await company(db, ctx);
  if (!c.siren) throw new AppError("VALIDATION", "Le SIREN de l'entreprise est requis pour nommer le FEC (Paramètres › Entreprise).");
  const { to } = fiscalYearBounds(c, fiscalYear);
  const rows = await db
    .select({
      journalCode: journalEntries.journalCode,
      journalLib: journals.label,
      entrySeq: journalEntries.entrySeq,
      entryDate: journalEntries.entryDate,
      account: journalLines.accountNumber,
      accountLabel: ledgerAccounts.label,
      auxNumber: journalLines.auxNumber,
      auxLabel: journalLines.auxLabel,
      pieceRef: journalEntries.pieceRef,
      pieceDate: journalEntries.pieceDate,
      label: journalLines.label,
      debit: journalLines.debit,
      credit: journalLines.credit,
      validatedAt: journalEntries.validatedAt,
      letterCode: letterings.code,
      letteredAt: letterings.letteredAt,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(journals, and(eq(journals.companyId, journalEntries.companyId), eq(journals.code, journalEntries.journalCode)))
    .innerJoin(ledgerAccounts, and(eq(ledgerAccounts.companyId, journalLines.companyId), eq(ledgerAccounts.number, journalLines.accountNumber)))
    .leftJoin(letteringLines, eq(letteringLines.lineId, journalLines.id))
    .leftJoin(letterings, eq(letterings.id, letteringLines.letteringId))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.fiscalYear, fiscalYear)))
    // Les à-nouveaux (reprise des soldes) figurent en tête du fichier.
    .orderBy(sql`case when ${journalEntries.journalCode} = 'AN' then 0 else 1 end`, asc(journalEntries.entrySeq), asc(journalLines.lineNo));
  const validDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(d);
  const lines = rows.map((r) =>
    [
      r.journalCode,
      fecText(r.journalLib),
      String(r.entrySeq),
      fecDate(r.entryDate),
      r.account,
      fecText(r.accountLabel),
      fecText(r.auxNumber),
      fecText(r.auxLabel),
      fecText(r.pieceRef),
      fecDate(r.pieceDate),
      fecText(r.label),
      fecAmount(r.debit),
      fecAmount(r.credit),
      r.letterCode ?? "",
      r.letteredAt ? fecDate(validDate(r.letteredAt)) : "",
      fecDate(validDate(r.validatedAt)),
      "",
      "",
    ].join("\t"),
  );
  return {
    filename: `${c.siren}FEC${fecDate(to)}.txt`,
    content: [FEC_HEADERS.join("\t"), ...lines].join("\r\n") + "\r\n",
    lineCount: rows.length,
  };
}

/** Contrôles de cohérence d'un exercice : équilibre global et continuité de la numérotation. */
export async function checkLedger(db: Executor, ctx: CompanyContext, fiscalYear: number) {
  assertPermission(ctx, "accounting.read");
  const [[sums], seqs] = await Promise.all([
    db
      .select({ debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`, credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)::text` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.fiscalYear, fiscalYear))),
    db
      .select({ seq: journalEntries.entrySeq })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.fiscalYear, fiscalYear)))
      .orderBy(asc(journalEntries.entrySeq)),
  ]);
  const gaps = seqs.filter((s, i) => s.seq !== i + 1).length;
  return { balanced: dec(sums!.debit).equals(dec(sums!.credit)), debit: dec(sums!.debit).toFixed(2), credit: dec(sums!.credit).toFixed(2), entries: seqs.length, continuous: gaps === 0 };
}

