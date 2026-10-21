import Link from "next/link";
import { CheckCircle2, Link2, XCircle } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@/components/ui/card";
import { FilterTabs, type SearchParams } from "@/components/data/list-controls";
import { getDb } from "@/server/db/client";
import type { CompanyContext } from "@/server/security/permissions";
import { can } from "@/server/security/permissions";
import { auxiliaryAccounts, fiscalYearClosingPreview, letteringAccounts, letteringLinesOf, listFiscalYears, listLedgerAccounts, vatSummary } from "@/server/services/accounting-closing";
import { todayInParis } from "@/server/domain/numbering";
import { ManualEntryForm } from "./manual-entry-form";
import { addDays } from "@/server/domain/sales";
import { dec, formatEuro, formatRate } from "@/server/domain/money";
import { formatDate } from "../ventes/sales-ui";
import { AutoLetterButton, CloseFiscalYearButton, LetteringTable } from "./closing-client";

const BASE = "/comptabilite";

export async function LetteringView({ params, ctx }: { params: SearchParams; ctx: CompanyContext }) {
  const db = await getDb();
  const accounts = await letteringAccounts(db, ctx);
  const selectedKey = typeof params.compte === "string" ? params.compte : "";
  const selected = accounts.find((a) => `${a.account}|${a.aux ?? ""}` === selectedKey) ?? accounts.find((a) => a.open > 0) ?? accounts[0];
  const lines = selected ? await letteringLinesOf(db, ctx, selected.account, selected.aux) : [];
  const canWrite = can(ctx, "accounting.write");
  const href = (a: (typeof accounts)[number]) => {
    const q = new URLSearchParams({ vue: "lettrage", compte: `${a.account}|${a.aux ?? ""}` });
    if (typeof params.exercice === "string") q.set("exercice", params.exercice);
    return `${BASE}?${q}`;
  };

  if (accounts.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Link2 className="size-5" aria-hidden />} title="Aucun compte de tiers" description="Le lettrage rapproche factures et règlements sur les comptes clients (411) et fournisseurs (401)." />
      </Card>
    );
  }
  return (
    <div className="grid gap-6 xl:grid-cols-4">
      <Card className="xl:col-span-1">
        <CardHeader title="Comptes de tiers" description="Solde non lettré" actions={canWrite ? <AutoLetterButton /> : undefined} className="flex-col" />
        <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto text-[13px]">
          {accounts.map((a) => {
            const active = selected && a.account === selected.account && a.aux === selected.aux;
            return (
              <li key={`${a.account}|${a.aux}`}>
                <Link href={href(a)} className={`flex items-center justify-between gap-2 px-5 py-2.5 hover:bg-muted/50 ${active ? "bg-accent-soft" : ""}`}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{a.auxLabel ?? a.account}</span>
                    <span className="text-xs text-foreground-muted">
                      {a.account} {a.aux}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="tabular block">{formatEuro(a.openBalance)}</span>
                    {a.open > 0 && <span className="text-xs text-foreground-muted">{a.open} ligne(s)</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card className="xl:col-span-3">
        <CardHeader
          title={selected ? `${selected.auxLabel ?? ""} — ${selected.account} ${selected.aux ?? ""}` : "Compte"}
          description="Lettrez des lignes d'un même exercice dont le solde est nul. Après clôture, le solde d'un tiers est repris par l'écriture d'à-nouveaux (journal AN)."
        />
        <LetteringTable lines={lines.map((l) => ({ ...l, letteredAt: undefined, method: undefined }))} canWrite={canWrite} />
      </Card>
    </div>
  );
}

/** Mois de l'exercice et trimestres, pour la sélection de la période de TVA. */
function vatPeriods(from: string) {
  const months = Array.from({ length: 12 }, (_, i) => {
    const start = new Date(`${from}T00:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() + i);
    const s = start.toISOString().slice(0, 10);
    const next = new Date(start);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return { value: s.slice(0, 7), from: s, to: addDays(next.toISOString().slice(0, 10), -1) };
  });
  const quarters = [0, 1, 2, 3].map((q) => ({ value: `T${q + 1}`, from: months[q * 3]!.from, to: months[q * 3 + 2]!.to }));
  return { months, quarters };
}

const MONTH_LABEL = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("fr-FR", { month: "short", year: "2-digit", timeZone: "UTC" });

export async function VatView({ params, ctx, from }: { params: SearchParams; ctx: CompanyContext; from: string }) {
  const { months, quarters } = vatPeriods(from);
  const all = [...months, ...quarters];
  const period = all.find((p) => p.value === params.periode) ?? quarters[0]!;
  const s = await vatSummary(await getDb(), ctx, period.from, period.to);
  const due = dec(s.balance);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <FilterTabs base={BASE} params={params} name="periode" value={period.value} options={quarters.map((q) => ({ value: q.value, label: q.value }))} />
        <FilterTabs base={BASE} params={params} name="periode" value={period.value} options={months.map((m) => ({ value: m.value, label: MONTH_LABEL(m.value) }))} />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={`TVA du ${formatDate(period.from)} au ${formatDate(period.to)}`} description="Montants issus des écritures de la période (hors à-nouveaux)." />
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-foreground-muted">
                <th className="px-5 py-2.5 font-medium">Rubrique</th>
                <th className="px-5 py-2.5 text-right font-medium">Base HT</th>
                <th className="px-5 py-2.5 text-right font-medium">TVA</th>
              </tr>
            </thead>
            <tbody>
              {s.collected.length === 0 && dec(s.otherCollected).isZero() && (
                <tr className="border-b border-border">
                  <td className="px-5 py-2 text-foreground-muted" colSpan={3}>
                    Aucune TVA collectée exigible sur la période.
                  </td>
                </tr>
              )}
              {s.collected.map((c) => (
                <tr key={c.rate} className="border-b border-border">
                  <td className="px-5 py-2">TVA collectée {formatRate(c.rate)} <span className="text-xs text-foreground-subtle">({c.account})</span></td>
                  <td className="tabular px-5 py-2 text-right">{formatEuro(c.base)}</td>
                  <td className="tabular px-5 py-2 text-right">{formatEuro(c.vat)}</td>
                </tr>
              ))}
              {!dec(s.otherCollected).isZero() && (
                <tr className="border-b border-border">
                  <td className="px-5 py-2">TVA collectée, autres taux (445710)</td>
                  <td />
                  <td className="tabular px-5 py-2 text-right">{formatEuro(s.otherCollected)}</td>
                </tr>
              )}
              <tr className="border-b border-border font-medium">
                <td className="px-5 py-2">Total TVA brute</td>
                <td />
                <td className="tabular px-5 py-2 text-right">{formatEuro(s.totalCollected)}</td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-5 py-2">TVA déductible sur immobilisations (445620)</td>
                <td />
                <td className="tabular px-5 py-2 text-right">{formatEuro(s.deductibleAssets)}</td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-5 py-2">TVA déductible sur autres biens et services (445660)</td>
                <td />
                <td className="tabular px-5 py-2 text-right">{formatEuro(s.deductibleGoods)}</td>
              </tr>
              {!dec(s.otherDeductible).isZero() && (
                <tr className="border-b border-border">
                  <td className="px-5 py-2">Autre TVA déductible</td>
                  <td />
                  <td className="tabular px-5 py-2 text-right">{formatEuro(s.otherDeductible)}</td>
                </tr>
              )}
              <tr className="border-b border-border font-medium">
                <td className="px-5 py-2">Total TVA déductible</td>
                <td />
                <td className="tabular px-5 py-2 text-right">{formatEuro(s.totalDeductible)}</td>
              </tr>
              <tr className="text-base font-semibold">
                <td className="px-5 py-3">{due.isNegative() ? "Crédit de TVA" : "TVA nette due"}</td>
                <td />
                <td className={`tabular px-5 py-3 text-right ${due.isNegative() ? "text-success" : ""}`}>{formatEuro(due.abs())}</td>
              </tr>
            </tbody>
          </table>
        </Card>
        <Card>
          <CardHeader title="À savoir" />
          <CardBody className="space-y-2 text-[13px] text-foreground-muted">
            <p>
              Ce tableau est une <strong className="text-foreground">aide</strong> : il ne constitue pas une déclaration. Reportez les montants
              sur le formulaire en vigueur (3310-CA3) en suivant sa notice, ou faites-les valider par votre expert-comptable.
            </p>
            <p>Les bases HT sont reconstituées à partir de la TVA et du taux (écart possible de quelques centimes).</p>
            <p>
              TVA collectée en attente d&apos;encaissement à la fin de la période (non exigible) :{" "}
              <span className="tabular font-medium text-foreground">{formatEuro(s.pendingAtEnd)}</span>.
            </p>
            <p>Les régularisations, acquisitions intracommunautaires, autoliquidations et crédits antérieurs ne sont pas traités ici.</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

export async function ClosingView({ ctx, fiscalYear }: { ctx: CompanyContext; fiscalYear: number }) {
  const db = await getDb();
  const [preview, years] = await Promise.all([fiscalYearClosingPreview(db, ctx, fiscalYear), listFiscalYears(db, ctx)]);
  const profit = !dec(preview.result).isNegative();
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader
          title={`Clôture de l'exercice ${fiscalYear}`}
          description={`Du ${formatDate(preview.from)} au ${formatDate(preview.to)} · ${preview.entryCount} écriture(s)`}
        />
        <CardBody className="space-y-4 text-[13px]">
          <p>
            Résultat {preview.closure ? "" : "provisoire "}:{" "}
            <span className={`tabular text-base font-semibold ${profit ? "text-success" : "text-danger"}`}>
              {profit ? "bénéfice" : "perte"} de {formatEuro(dec(preview.result).abs())}
            </span>
          </p>
          {preview.closure ? (
            <div className="rounded-md bg-success-soft px-3 py-2 text-success">
              Exercice clôturé le {preview.closure.closedAt.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}. À-nouveaux enregistrés au{" "}
              {formatDate(addDays(preview.to, 1))} (journal AN).
            </div>
          ) : (
            <>
              <ul className="space-y-1.5">
                {preview.checks.map((c) => (
                  <li key={c.label} className="flex items-start gap-2">
                    {c.ok ? <CheckCircle2 className="mt-0.5 size-4 text-success" aria-hidden /> : <XCircle className="mt-0.5 size-4 text-danger" aria-hidden />}
                    <span>
                      {c.label}
                      {c.detail && <span className="block text-xs text-foreground-muted">{c.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {can(ctx, "accounting.close") ? (
                preview.canClose ? (
                  <CloseFiscalYearButton fiscalYear={fiscalYear} result={preview.result} />
                ) : (
                  <p className="text-foreground-muted">La clôture sera possible lorsque tous les contrôles seront satisfaits.</p>
                )
              ) : (
                <p className="text-foreground-muted">Votre rôle ne permet pas la clôture (propriétaire ou comptable).</p>
              )}
            </>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Exercices" />
        <ul className="divide-y divide-border text-[13px]">
          {years.map((y) => (
            <li key={y.year} className="flex items-center justify-between px-5 py-2.5">
              <Link href={`${BASE}?vue=cloture&exercice=${y.year}`} className="font-medium hover:text-accent">
                {y.year}
                <span className="block text-xs font-normal text-foreground-muted">
                  {formatDate(y.from)} – {formatDate(y.to)}
                </span>
              </Link>
              {y.closure ? <Badge tone="success">Clôturé</Badge> : <Badge>Ouvert</Badge>}
            </li>
          ))}
        </ul>
        <CardBody className="text-xs text-foreground-subtle">
          Avant de clôturer, saisissez avec votre expert-comptable les écritures d&apos;inventaire (amortissements, provisions, stocks,
          charges et produits constatés d&apos;avance) dans « Saisie OD ». L&apos;affectation du résultat, décidée ensuite, se saisit
          également en OD sur l&apos;exercice suivant.
        </CardBody>
      </Card>
    </div>
  );
}

export async function ManualEntryView({ ctx }: { ctx: CompanyContext }) {
  if (!can(ctx, "accounting.write")) {
    return (
      <Card>
        <CardBody className="text-[13px] text-foreground-muted">Votre rôle ne permet pas la saisie d&apos;écritures.</CardBody>
      </Card>
    );
  }
  const db = await getDb();
  const [accounts, parties] = await Promise.all([listLedgerAccounts(db, ctx), auxiliaryAccounts(db, ctx)]);
  return (
    <Card>
      <CardHeader
        title="Saisie d'une opération diverse"
        description="Écritures d'inventaire (amortissements, provisions, charges et produits constatés d'avance…), affectation du résultat, corrections. Journal OD."
      />
      <CardBody>
        <ManualEntryForm accounts={accounts} parties={parties} today={todayInParis()} />
      </CardBody>
    </Card>
  );
}
