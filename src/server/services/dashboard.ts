import { and, asc, desc, eq, gte, lte, ne, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { companies, payments, salesDocuments, thirdParties } from "../db/schema";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { D, dec } from "../domain/money";
import { addDays, QUOTE_VALIDITY_DAYS } from "../domain/sales";
import { todayInParis } from "../domain/numbering";
import { invoiceBalances } from "./payments";

/**
 * Indicateurs du tableau de bord, calculés exclusivement à partir des données métier.
 * Règles de calcul : docs/04-regles-calcul.md §8.
 */

export const PERIODS = ["mois", "trimestre", "exercice", "12mois"] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_LABELS: Record<Period, string> = {
  mois: "Ce mois",
  trimestre: "Ce trimestre",
  exercice: "Exercice en cours",
  "12mois": "12 derniers mois",
};

export function periodBounds(period: Period, today: string, fiscalYearStartMonth: number): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, "0");
  if (period === "mois") return { from: `${y}-${pad(m)}-01`, to: today };
  if (period === "trimestre") {
    const qStart = Math.floor((m - 1) / 3) * 3 + 1;
    return { from: `${y}-${pad(qStart)}-01`, to: today };
  }
  if (period === "exercice") {
    const startYear = m >= fiscalYearStartMonth ? y : y - 1;
    return { from: `${startYear}-${pad(fiscalYearStartMonth)}-01`, to: today };
  }
  const from = new Date(Date.UTC(y, m - 12, 1));
  return { from: from.toISOString().slice(0, 10), to: today };
}

/** Les 12 derniers mois (AAAA-MM), du plus ancien au plus récent. */
export function lastTwelveMonths(today: string): string[] {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 12 + i, 1));
    return d.toISOString().slice(0, 7);
  });
}

export async function getDashboard(db: Executor, ctx: CompanyContext, period: Period, now?: Date) {
  assertPermission(ctx, "sales.read");
  const today = todayInParis(now);
  const [company] = await db.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  const { from, to } = periodBounds(period, today, company!.fiscalYearStartMonth);
  const months = lastTwelveMonths(today);
  const chartFrom = `${months[0]}-01`;

  const issuedSales = and(eq(salesDocuments.companyId, ctx.companyId), ne(salesDocuments.status, "draft"));
  const signedHt = sql`case when ${salesDocuments.type} = 'credit_note' then -${salesDocuments.totalExclTax} else ${salesDocuments.totalExclTax} end`;
  const signedVat = sql`case when ${salesDocuments.type} = 'credit_note' then -${salesDocuments.totalVat} else ${salesDocuments.totalVat} end`;
  const revenueDocs = sql`${salesDocuments.type} in ('invoice', 'credit_note')`;

  const [[revenue], [cash], monthlyRevenue, monthlyCash, balances, recentDocs, recentPayments, staleQuotes, oldDrafts] =
    await Promise.all([
      db
        .select({
          ht: sql<string>`coalesce(sum(${signedHt}), 0)::text`,
          vat: sql<string>`coalesce(sum(${signedVat}), 0)::text`,
          invoices: sql<number>`count(*) filter (where ${salesDocuments.type} = 'invoice')::int`,
        })
        .from(salesDocuments)
        .where(and(issuedSales, revenueDocs, gte(salesDocuments.issueDate, from), lte(salesDocuments.issueDate, to))),
      db
        .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)::text` })
        .from(payments)
        .where(and(eq(payments.companyId, ctx.companyId), gte(payments.paymentDate, from), lte(payments.paymentDate, to))),
      db
        .select({ month: sql<string>`substr(${salesDocuments.issueDate}, 1, 7)`, ht: sql<string>`sum(${signedHt})::text` })
        .from(salesDocuments)
        .where(and(issuedSales, revenueDocs, gte(salesDocuments.issueDate, chartFrom)))
        .groupBy(sql`1`),
      db
        .select({ month: sql<string>`substr(${payments.paymentDate}, 1, 7)`, total: sql<string>`sum(${payments.amount})::text` })
        .from(payments)
        .where(and(eq(payments.companyId, ctx.companyId), gte(payments.paymentDate, chartFrom)))
        .groupBy(sql`1`),
      invoiceBalances(db, ctx, {}, now),
      db
        .select({
          id: salesDocuments.id,
          type: salesDocuments.type,
          number: salesDocuments.number,
          issueDate: salesDocuments.issueDate,
          totalInclTax: salesDocuments.totalInclTax,
          partyName: thirdParties.name,
        })
        .from(salesDocuments)
        .innerJoin(thirdParties, and(eq(thirdParties.id, salesDocuments.thirdPartyId), eq(thirdParties.companyId, salesDocuments.companyId)))
        .where(issuedSales)
        .orderBy(desc(salesDocuments.issuedAt))
        .limit(5),
      db
        .select({ id: payments.id, number: payments.number, kind: payments.kind, paymentDate: payments.paymentDate, amount: payments.amount, partyName: thirdParties.name })
        .from(payments)
        .innerJoin(thirdParties, and(eq(thirdParties.id, payments.thirdPartyId), eq(thirdParties.companyId, payments.companyId)))
        .where(eq(payments.companyId, ctx.companyId))
        .orderBy(desc(payments.chainSeq))
        .limit(5),
      db
        .select({ id: salesDocuments.id, number: salesDocuments.number, dueDate: salesDocuments.dueDate, partyName: thirdParties.name })
        .from(salesDocuments)
        .innerJoin(thirdParties, and(eq(thirdParties.id, salesDocuments.thirdPartyId), eq(thirdParties.companyId, salesDocuments.companyId)))
        .where(and(issuedSales, eq(salesDocuments.type, "quote"), eq(salesDocuments.status, "issued"), sql`${salesDocuments.dueDate} < ${today}`))
        .orderBy(asc(salesDocuments.dueDate))
        .limit(5),
      db
        .select({ id: salesDocuments.id, type: salesDocuments.type, createdAt: salesDocuments.createdAt, partyName: thirdParties.name })
        .from(salesDocuments)
        .innerJoin(thirdParties, and(eq(thirdParties.id, salesDocuments.thirdPartyId), eq(thirdParties.companyId, salesDocuments.companyId)))
        .where(
          and(
            eq(salesDocuments.companyId, ctx.companyId),
            eq(salesDocuments.status, "draft"),
            sql`${salesDocuments.createdAt} < ${addDays(today, -7)}::date`,
          ),
        )
        .orderBy(asc(salesDocuments.createdAt))
        .limit(5),
    ]);

  const receivable = balances.filter((b) => dec(b.remaining).greaterThan(0));
  const overdue = balances.filter((b) => b.status === "overdue");
  const sum = (list: { remaining: string }[]) => list.reduce((acc, b) => acc.plus(b.remaining), new D(0)).toFixed(2);
  const byMonth = (rows: { month: string; value: string }[]) =>
    months.map((m) => rows.find((r) => r.month === m)?.value ?? "0");

  return {
    today,
    period: { key: period, from, to },
    revenueExclTax: dec(revenue!.ht).toFixed(2),
    invoiceCount: revenue!.invoices,
    collected: dec(cash!.total).toFixed(2),
    estimatedVat: dec(revenue!.vat).toFixed(2),
    vatOnDebits: company!.vatOnDebits,
    receivables: { amount: sum(receivable), count: receivable.length },
    overdue: {
      amount: sum(overdue),
      count: overdue.length,
      top: [...overdue].sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "")).slice(0, 5),
    },
    chart: {
      months,
      revenue: byMonth(monthlyRevenue.map((r) => ({ month: r.month, value: r.ht }))),
      collected: byMonth(monthlyCash.map((r) => ({ month: r.month, value: r.total }))),
    },
    recentDocs,
    recentPayments,
    alerts: { staleQuotes, oldDrafts, quoteValidityDays: QUOTE_VALIDITY_DAYS },
  };
}

export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;
