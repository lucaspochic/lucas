import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen, Download, ShieldCheck, ShieldAlert } from "lucide-react";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { FilterTabs, Pagination, type SearchParams } from "@/components/data/list-controls";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import {
  agedBalances,
  checkLedger,
  currentFiscalYear,
  fiscalYearBounds,
  generalLedger,
  listEntries,
  listJournals,
  trialBalance,
} from "@/server/services/accounting-reports";
import { loadCompany } from "@/server/services/accounting";
import { formatEuro } from "@/server/domain/money";
import { formatDate } from "../ventes/sales-ui";
import { ClosingView, LetteringView, ManualEntryView, VatView } from "./closing-views";

export const metadata: Metadata = { title: "Comptabilité" };

const BASE = "/comptabilite";
const VIEWS = ["ecritures", "balance", "grand-livre", "echeancier", "lettrage", "tva", "saisie", "cloture", "export"] as const;
const amount = (v: string) => (v === "0.00" ? "" : formatEuro(v));

export default async function AccountingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { ctx } = await requirePermission("accounting.read");
  const db = await getDb();
  const view = VIEWS.find((v) => v === params.vue) ?? "ecritures";
  const company = await loadCompany(db, ctx.companyId);
  const current = await currentFiscalYear(db, ctx);
  const fiscalYear = Number(params.exercice) || current;
  const { from, to } = fiscalYearBounds(company, fiscalYear);
  const years = [current, current - 1, current - 2];
  const check = await checkLedger(db, ctx, fiscalYear);

  return (
    <>
      <PageHeader
        title="Comptabilité"
        description={`Exercice ${fiscalYear} — du ${formatDate(from)} au ${formatDate(to)}. Écritures automatiques ou saisies en OD, validées et intangibles.`}
        actions={
          <FilterTabs base={BASE} params={params} name="exercice" value={String(fiscalYear)} options={years.map((y) => ({ value: String(y), label: String(y) }))} />
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterTabs
          base={BASE}
          params={params}
          name="vue"
          value={view}
          options={[
            { value: "ecritures", label: "Écritures" },
            { value: "balance", label: "Balance" },
            { value: "grand-livre", label: "Grand livre" },
            { value: "echeancier", label: "Échéancier" },
            { value: "lettrage", label: "Lettrage" },
            { value: "tva", label: "TVA" },
            { value: "saisie", label: "Saisie OD" },
            { value: "cloture", label: "Clôture" },
            { value: "export", label: "Export FEC" },
          ]}
        />
        <span className={`inline-flex items-center gap-1.5 text-[13px] ${check.balanced && check.continuous ? "text-success" : "text-danger"}`}>
          {check.balanced && check.continuous ? <ShieldCheck className="size-4" aria-hidden /> : <ShieldAlert className="size-4" aria-hidden />}
          {check.entries} écriture(s) — {check.balanced ? "équilibrées" : "DÉSÉQUILIBRE"} — numérotation {check.continuous ? "continue" : "DISCONTINUE"}
        </span>
      </div>

      {view === "ecritures" && <EntriesView params={params} fiscalYear={fiscalYear} ctx={ctx} />}
      {view === "balance" && <BalanceView from={from} to={to} ctx={ctx} />}
      {view === "grand-livre" && <LedgerView params={params} from={from} to={to} ctx={ctx} />}
      {view === "echeancier" && <AgedView ctx={ctx} />}
      {view === "lettrage" && <LetteringView params={params} ctx={ctx} />}
      {view === "tva" && <VatView params={params} ctx={ctx} from={from} />}
      {view === "saisie" && <ManualEntryView ctx={ctx} />}
      {view === "cloture" && <ClosingView ctx={ctx} fiscalYear={fiscalYear} />}
      {view === "export" && (
        <Card>
          <CardHeader title="Fichier des écritures comptables (FEC)" description="Format de l'article A. 47 A-1 du LPF : tabulation, UTF-8, dates AAAAMMJJ, virgule décimale." />
          <CardBody className="space-y-3 text-[13px]">
            {can(ctx, "exports.run") ? (
              company.siren ? (
                <a
                  href={`/api/exports/fec?exercice=${fiscalYear}`}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
                >
                  <Download className="size-4" aria-hidden /> Télécharger le FEC {fiscalYear}
                </a>
              ) : (
                <p className="text-danger">Renseignez le SIREN de l&apos;entreprise (Paramètres › Entreprise) : il compose le nom du fichier.</p>
              )
            ) : (
              <p className="text-foreground-muted">Votre rôle ne permet pas l&apos;export.</p>
            )}
            <p className="text-foreground-muted">
              À remettre avec son descriptif (documentation fournie avec le logiciel : <span className="font-mono">docs/13-fec-descriptif.md</span>).
              Le fichier comprend les à-nouveaux (en tête) et le lettrage des comptes de tiers. Les écritures d&apos;inventaire sont à saisir
              en opérations diverses avec votre expert-comptable.
            </p>
          </CardBody>
        </Card>
      )}
    </>
  );
}

type Ctx = Awaited<ReturnType<typeof requirePermission>>["ctx"];

async function EntriesView({ params, fiscalYear, ctx }: { params: SearchParams; fiscalYear: number; ctx: Ctx }) {
  const db = await getDb();
  const journals = await listJournals(db, ctx);
  const journalCode = journals.find((j) => j.code === params.journal)?.code;
  const page = Math.max(1, Number(params.page) || 1);
  const { rows, total, pageSize } = await listEntries(db, ctx, { fiscalYear, journalCode, page });
  return (
    <Card>
      <div className="border-b border-border px-5 py-3">
        <FilterTabs
          base={BASE}
          params={params}
          name="journal"
          value={journalCode ?? ""}
          options={[{ value: "", label: "Tous journaux" }, ...journals.map((j) => ({ value: j.code, label: `${j.code} ${j.label}` }))]}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={<BookOpen className="size-5" aria-hidden />} title="Aucune écriture" description="Les écritures sont générées à l'émission des factures, à l'enregistrement des règlements et des dépenses." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-foreground-muted">
                <th className="px-5 py-2.5 font-medium">N°</th>
                <th className="px-5 py-2.5 font-medium">Date</th>
                <th className="px-5 py-2.5 font-medium">Jnl</th>
                <th className="px-5 py-2.5 font-medium">Pièce</th>
                <th className="px-5 py-2.5 font-medium">Compte</th>
                <th className="px-5 py-2.5 font-medium">Libellé</th>
                <th className="px-5 py-2.5 text-right font-medium">Débit</th>
                <th className="px-5 py-2.5 text-right font-medium">Crédit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) =>
                e.lines.map((l, i) => (
                  <tr key={l.id} className={i === e.lines.length - 1 ? "border-b border-border-strong" : "border-b border-border/60"}>
                    <td className="tabular px-5 py-1.5 text-foreground-muted">{i === 0 ? e.entrySeq : ""}</td>
                    <td className="tabular whitespace-nowrap px-5 py-1.5 text-foreground-muted">{i === 0 ? formatDate(e.entryDate) : ""}</td>
                    <td className="px-5 py-1.5 font-mono text-xs">{i === 0 ? e.journalCode : ""}</td>
                    <td className="whitespace-nowrap px-5 py-1.5 font-mono text-xs">{i === 0 ? e.pieceRef : ""}</td>
                    <td className="whitespace-nowrap px-5 py-1.5 font-mono text-xs">
                      <Link href={`${BASE}?vue=grand-livre&compte=${l.accountNumber}`} className="hover:text-accent">
                        {l.accountNumber}
                      </Link>
                      {l.auxNumber && <span className="ml-1 text-foreground-subtle">{l.auxNumber}</span>}
                    </td>
                    <td className="min-w-72 px-5 py-1.5">
                      <span className={i === 0 ? "" : "text-foreground-muted"}>{i === 0 || l.label !== e.label ? l.label : ""}</span>
                    </td>
                    <td className="tabular whitespace-nowrap px-5 py-1.5 text-right">{amount(l.debit)}</td>
                    <td className="tabular whitespace-nowrap px-5 py-1.5 text-right">{amount(l.credit)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
      <Pagination base={BASE} params={params} page={page} total={total} pageSize={pageSize} />
    </Card>
  );
}

async function BalanceView({ from, to, ctx }: { from: string; to: string; ctx: Ctx }) {
  const tb = await trialBalance(await getDb(), ctx, from, to);
  return (
    <Card>
      <CardHeader title="Balance générale" />
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-foreground-muted">
              <th className="px-5 py-2.5 font-medium">Compte</th>
              <th className="px-5 py-2.5 font-medium">Libellé</th>
              <th className="px-5 py-2.5 text-right font-medium">Débit</th>
              <th className="px-5 py-2.5 text-right font-medium">Crédit</th>
              <th className="px-5 py-2.5 text-right font-medium">Solde débiteur</th>
              <th className="px-5 py-2.5 text-right font-medium">Solde créditeur</th>
            </tr>
          </thead>
          <tbody>
            {tb.accounts.map((a) => (
              <tr key={a.account} className="border-b border-border">
                <td className="px-5 py-2 font-mono text-xs">
                  <Link href={`${BASE}?vue=grand-livre&compte=${a.account}`} className="hover:text-accent">
                    {a.account}
                  </Link>
                </td>
                <td className="px-5 py-2">{a.label}</td>
                <td className="tabular px-5 py-2 text-right">{amount(a.debit)}</td>
                <td className="tabular px-5 py-2 text-right">{amount(a.credit)}</td>
                <td className="tabular px-5 py-2 text-right font-medium">{amount(a.debitBalance)}</td>
                <td className="tabular px-5 py-2 text-right font-medium">{amount(a.creditBalance)}</td>
              </tr>
            ))}
            <tr className="bg-surface font-semibold">
              <td className="px-5 py-2.5" colSpan={2}>
                Totaux
              </td>
              <td className="tabular px-5 py-2.5 text-right">{formatEuro(tb.totals.debit)}</td>
              <td className="tabular px-5 py-2.5 text-right">{formatEuro(tb.totals.credit)}</td>
              <td className="tabular px-5 py-2.5 text-right">{formatEuro(tb.totals.debitBalance)}</td>
              <td className="tabular px-5 py-2.5 text-right">{formatEuro(tb.totals.creditBalance)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

async function LedgerView({ params, from, to, ctx }: { params: SearchParams; from: string; to: string; ctx: Ctx }) {
  const account = typeof params.compte === "string" && /^[1-7]\d{2,7}$/.test(params.compte) ? params.compte : "411000";
  const gl = await generalLedger(await getDb(), ctx, account, from, to);
  return (
    <Card>
      <CardHeader
        title={`Grand livre — ${gl.account} ${gl.label ?? ""}`}
        description={`Solde d'ouverture ${formatEuro(gl.opening)} — solde de clôture ${formatEuro(gl.closing)} (positif = débiteur). Choisissez un compte depuis la balance.`}
      />
      {gl.rows.length === 0 ? (
        <EmptyState icon={<BookOpen className="size-5" aria-hidden />} title="Aucun mouvement" description="Aucune écriture sur ce compte pendant l'exercice." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-foreground-muted">
                <th className="px-5 py-2.5 font-medium">Date</th>
                <th className="px-5 py-2.5 font-medium">N°</th>
                <th className="px-5 py-2.5 font-medium">Pièce</th>
                <th className="px-5 py-2.5 font-medium">Libellé</th>
                <th className="px-5 py-2.5 text-right font-medium">Débit</th>
                <th className="px-5 py-2.5 text-right font-medium">Crédit</th>
                <th className="px-5 py-2.5 text-right font-medium">Solde</th>
              </tr>
            </thead>
            <tbody>
              {gl.rows.map((r, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="tabular whitespace-nowrap px-5 py-2 text-foreground-muted">{formatDate(r.entryDate)}</td>
                  <td className="tabular px-5 py-2 text-foreground-muted">
                    {r.journalCode} {r.entrySeq}
                  </td>
                  <td className="px-5 py-2 font-mono text-xs">{r.pieceRef}</td>
                  <td className="px-5 py-2">{r.label}</td>
                  <td className="tabular px-5 py-2 text-right">{amount(r.debit)}</td>
                  <td className="tabular px-5 py-2 text-right">{amount(r.credit)}</td>
                  <td className="tabular px-5 py-2 text-right font-medium">{formatEuro(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

async function AgedView({ ctx }: { ctx: Ctx }) {
  const aged = await agedBalances(await getDb(), ctx);
  const table = (title: string, data: typeof aged.receivables) => (
    <Card>
      <CardHeader title={title} description={`Total : ${formatEuro(data.total)}`} />
      {data.rows.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-foreground-muted">Rien en attente.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-foreground-muted">
                <th className="px-5 py-2.5 font-medium">Tiers</th>
                {aged.buckets.map((b) => (
                  <th key={b.key} className="whitespace-nowrap px-5 py-2.5 text-right font-medium">
                    {b.label}
                  </th>
                ))}
                <th className="px-5 py-2.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.party} className="border-b border-border">
                  <td className="px-5 py-2">{r.party}</td>
                  {aged.buckets.map((b) => (
                    <td key={b.key} className={`tabular px-5 py-2 text-right ${b.key !== "not_due" && r.buckets[b.key] !== "0.00" ? "text-danger" : ""}`}>
                      {amount(r.buckets[b.key])}
                    </td>
                  ))}
                  <td className="tabular px-5 py-2 text-right font-medium">{formatEuro(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
  return (
    <div className="space-y-6">
      {table("Créances clients", aged.receivables)}
      {table("Dettes fournisseurs", aged.payables)}
    </div>
  );
}
