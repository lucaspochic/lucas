import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Circle, FileClock, FileText } from "lucide-react";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { FilterTabs, type SearchParams } from "@/components/data/list-controls";
import { MonthlyChart } from "@/components/data/monthly-chart";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { getCompany } from "@/server/services/companies";
import { companySetupChecklist } from "@/server/services/company-setup";
import { getDashboard, PERIOD_LABELS, PERIODS } from "@/server/services/dashboard";
import { dec, formatEuro } from "@/server/domain/money";
import { expensesTotal } from "@/server/services/expenses";
import { accountBalances } from "@/server/services/treasury";
import { DOCUMENT_TYPE_LABELS } from "@/server/domain/sales";
import { can } from "@/server/security/permissions";
import { formatDate } from "../ventes/sales-ui";

export const metadata: Metadata = { title: "Tableau de bord" };

function Kpi({ label, value, hint, href, tone }: { label: string; value: string; hint?: string; href?: string; tone?: "danger" }) {
  const body = (
    <>
      <p className="text-[13px] text-foreground-muted">{label}</p>
      <p className={`tabular mt-1 text-2xl font-semibold tracking-tight ${tone === "danger" ? "text-danger" : ""}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-foreground-subtle">{hint}</p>}
    </>
  );
  return (
    <Card className="p-5">
      {href ? (
        <Link href={href} className="block hover:opacity-80">
          {body}
        </Link>
      ) : (
        body
      )}
    </Card>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { session, ctx } = await requireCompanyContext();
  const db = await getDb();
  const company = await getCompany(db, ctx);
  const checklist = companySetupChecklist(company);
  const done = checklist.filter((c) => c.done).length;
  const period = PERIODS.find((p) => p === params.periode) ?? "mois";

  if (!can(ctx, "sales.read")) {
    return <PageHeader title={`Bonjour ${session.fullName.split(" ")[0]}`} description={company.tradeName || company.legalName} />;
  }
  const d = await getDashboard(db, ctx, period);
  const [spent, balances] = await Promise.all([
    can(ctx, "purchases.read") ? expensesTotal(db, ctx, d.period.from, d.period.to) : Promise.resolve(null),
    can(ctx, "treasury.read") ? accountBalances(db, ctx) : Promise.resolve(null),
  ]);
  const treasury = balances ? balances.reduce((acc, a) => acc.plus(a.bookBalance), dec("0")) : null;
  const hasActivity = d.recentDocs.length > 0 || d.recentPayments.length > 0;
  const alertCount = d.overdue.count + d.alerts.staleQuotes.length + d.alerts.oldDrafts.length;

  return (
    <>
      <PageHeader
        title={`Bonjour ${session.fullName.split(" ")[0]}`}
        description={`${company.tradeName || company.legalName} — du ${formatDate(d.period.from)} au ${formatDate(d.period.to)}`}
        actions={
          <FilterTabs
            base="/tableau-de-bord"
            params={params}
            name="periode"
            value={period}
            options={PERIODS.map((p) => ({ value: p, label: PERIOD_LABELS[p] }))}
          />
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Chiffre d'affaires HT" value={formatEuro(d.revenueExclTax)} hint={`${d.invoiceCount} facture(s), avoirs déduits`} href="/ventes" />
        <Kpi label="Encaissements" value={formatEuro(d.collected)} hint="Règlements reçus, nets des remboursements" href="/reglements" />
        <Kpi label="Créances clients" value={formatEuro(d.receivables.amount)} hint={`${d.receivables.count} facture(s) à encaisser — à date`} />
        <Kpi
          label="Factures en retard"
          value={formatEuro(d.overdue.amount)}
          hint={`${d.overdue.count} facture(s) échue(s)`}
          tone={d.overdue.count > 0 ? "danger" : undefined}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Activité sur 12 mois" description="Chiffre d'affaires HT (date d'émission) et encaissements (date de paiement)." />
          <CardBody>
            {hasActivity ? (
              <MonthlyChart
                months={d.chart.months}
                seriesA={d.chart.revenue}
                seriesB={d.chart.collected}
                labelA="Chiffre d'affaires HT"
                labelB="Encaissements"
              />
            ) : (
              <EmptyState
                icon={<FileText className="size-5" aria-hidden />}
                title="Aucune activité"
                description="Les indicateurs apparaîtront dès l'émission de vos premières factures. Aucun chiffre n'est affiché sans donnée réelle."
              />
            )}
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="TVA collectée (estimation)" />
            <CardBody>
              <p className="tabular text-2xl font-semibold tracking-tight">{formatEuro(d.estimatedVat)}</p>
              <p className="mt-2 text-xs text-foreground-muted">
                Estimation sur la période d&apos;après les factures et avoirs émis
                {d.vatOnDebits ? "." : ". Pour les prestations de services sans option sur les débits, la TVA est exigible à l'encaissement : le montant à déclarer peut différer."}{" "}
                À valider avec votre déclaration de TVA.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="À traiter" description={alertCount === 0 ? "Rien d'urgent." : `${alertCount} point(s)`} />
            {alertCount > 0 && (
              <ul className="divide-y divide-border text-[13px]">
                {d.overdue.top.map((b) => (
                  <li key={b.id}>
                    <Link href={`/ventes/${b.id}`} className="flex items-start gap-2.5 px-5 py-2.5 hover:bg-surface">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="En retard" />
                      <span className="flex-1">
                        Facture <span className="font-mono text-xs">{b.number}</span> échue le {formatDate(b.dueDate!)}
                      </span>
                      <span className="tabular font-medium">{formatEuro(b.remaining)}</span>
                    </Link>
                  </li>
                ))}
                {d.alerts.staleQuotes.map((q) => (
                  <li key={q.id}>
                    <Link href={`/ventes/${q.id}`} className="flex items-start gap-2.5 px-5 py-2.5 hover:bg-surface">
                      <FileClock className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Devis expiré" />
                      <span>
                        Devis <span className="font-mono text-xs">{q.number}</span> ({q.partyName}) expiré sans réponse
                      </span>
                    </Link>
                  </li>
                ))}
                {d.alerts.oldDrafts.map((dr) => (
                  <li key={dr.id}>
                    <Link href={`/ventes/${dr.id}`} className="flex items-start gap-2.5 px-5 py-2.5 hover:bg-surface">
                      <FileText className="mt-0.5 size-4 shrink-0 text-foreground-subtle" aria-label="Brouillon" />
                      <span>
                        {DOCUMENT_TYPE_LABELS[dr.type]} brouillon pour {dr.partyName} depuis plus de 7 jours
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card>
          <CardHeader title="Derniers documents émis" />
          {d.recentDocs.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-foreground-muted">Aucun document émis.</p>
          ) : (
            <ul className="divide-y divide-border text-[13px]">
              {d.recentDocs.map((doc) => (
                <li key={doc.id}>
                  <Link href={`/ventes/${doc.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-surface">
                    <span className="min-w-0">
                      <span className="block font-mono text-xs">{doc.number}</span>
                      <span className="block truncate text-foreground-muted">{doc.partyName}</span>
                    </span>
                    <span className="tabular whitespace-nowrap font-medium">
                      {doc.type === "credit_note" ? "-" : ""}
                      {formatEuro(doc.totalInclTax)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Derniers règlements" />
          {d.recentPayments.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-foreground-muted">Aucun règlement.</p>
          ) : (
            <ul className="divide-y divide-border text-[13px]">
              {d.recentPayments.map((p) => (
                <li key={p.id}>
                  <Link href={`/reglements/${p.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-surface">
                    <span className="min-w-0">
                      <span className="block font-mono text-xs">{p.number}</span>
                      <span className="block truncate text-foreground-muted">
                        {p.partyName} · {formatDate(p.paymentDate)}
                      </span>
                    </span>
                    <span className={`tabular whitespace-nowrap font-medium ${p.amount.startsWith("-") ? "text-danger" : ""}`}>
                      {formatEuro(p.amount)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
          <Card>
            <CardHeader title="Trésorerie et dépenses" />
            <CardBody className="space-y-3 text-[13px]">
              {treasury !== null && (
                <Link href="/tresorerie" className="flex items-center justify-between hover:opacity-80">
                  <span className="text-foreground-muted">Trésorerie disponible (comptable)</span>
                  <span className="tabular text-base font-semibold">{formatEuro(treasury)}</span>
                </Link>
              )}
              {spent !== null && (
                <Link href="/depenses" className="flex items-center justify-between hover:opacity-80">
                  <span className="text-foreground-muted">Dépenses HT de la période</span>
                  <span className="tabular text-base font-semibold">{formatEuro(spent)}</span>
                </Link>
              )}
              {spent !== null && (
                <p className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-foreground-muted">Résultat indicatif (CA HT − dépenses HT)</span>
                  <span className="tabular font-medium">{formatEuro(dec(d.revenueExclTax).minus(spent))}</span>
                </p>
              )}
              <p className="text-xs text-foreground-subtle">Indicatif : hors amortissements, salaires et écritures d&apos;inventaire.</p>
            </CardBody>
          </Card>
      </div>
      {done < checklist.length && (
        <div className="mt-6 max-w-md">
            <Card>
              <CardHeader title="Configuration" description={`${done} / ${checklist.length} étapes complétées`} />
              <CardBody className="space-y-1 py-3">
                {checklist.map((item) => (
                  <Link key={item.key} href={item.href} className="flex items-start gap-2.5 rounded-md px-2 py-2 text-[13px] hover:bg-muted">
                    {item.done ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Fait" />
                    ) : (
                      <Circle className="mt-0.5 size-4 shrink-0 text-foreground-subtle" aria-label="À faire" />
                    )}
                    <span className={item.done ? "text-foreground-muted line-through" : "text-foreground"}>{item.label}</span>
                  </Link>
                ))}
              </CardBody>
            </Card>
        </div>
      )}
    </>
  );
}
