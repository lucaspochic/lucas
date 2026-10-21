import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form-controls";
import { getDb } from "@/server/db/client";
import { orNotFound, requirePermission } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { dayTotals, getRegister, listArchives, listClosures, listSessions, listTickets, posCatalog, posVatRates } from "@/server/services/cash";
import { formatEuro, formatRate } from "@/server/domain/money";
import { todayInParis } from "@/server/domain/numbering";
import { PAYMENT_METHOD_LABELS } from "@/lib/schemas";
import { formatDate } from "../../ventes/sales-ui";
import { CloseDayButton, CloseSessionForm, OpenSessionForm, PosTerminal, VerifyRegisterButton } from "../cash-client";

export const metadata: Metadata = { title: "Caisse" };
export const dynamic = "force-dynamic";

const CLOSURE_LABELS = { day: "Journée", month: "Mois", year: "Exercice" } as const;
const time = (d: Date) => d.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
const dateTime = (d: Date) => d.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" });

export default async function RegisterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requirePermission("cash.operate");
  const db = await getDb();
  const today = todayInParis();
  const { register, openSession, lastDayClosure, perpetualTotal } = await orNotFound(getRegister(db, ctx, id));
  const [catalog, rates, tickets, totals, closures, sessions, archives] = await Promise.all([
    posCatalog(db, ctx),
    posVatRates(db, ctx),
    listTickets(db, ctx, id, { date: today, limit: 30 }),
    dayTotals(db, ctx, id, today),
    listClosures(db, ctx, id),
    listSessions(db, ctx, id),
    listArchives(db, ctx, id),
  ]);
  const canClose = can(ctx, "cash.close");
  const dayClosed = lastDayClosure?.periodStart === today;

  return (
    <>
      <PageHeader
        title={`Caisse ${register.code} — ${register.name}`}
        description={`Total perpétuel ${formatEuro(perpetualTotal)} · ${openSession ? `ouverte depuis ${dateTime(openSession.openedAt)}` : "fermée"}${dayClosed ? " · journée clôturée" : ""}`}
        actions={
          <Link href="/caisse" className="text-[13px] text-foreground-muted hover:text-foreground">
            Toutes les caisses
          </Link>
        }
      />

      {dayClosed ? (
        <Card className="mb-6">
          <CardBody className="text-[13px] text-foreground-muted">La journée est clôturée : les ventes reprendront demain sur cette caisse.</CardBody>
        </Card>
      ) : openSession ? (
        <div className="mb-6">
          <PosTerminal registerId={register.id} catalog={catalog} vatRates={rates} />
        </div>
      ) : (
        <Card className="mb-6">
          <CardHeader title="Ouvrir la caisse" description="Indiquez le fond de caisse présent dans le tiroir." />
          <CardBody>
            <OpenSessionForm registerId={register.id} />
          </CardBody>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title={`Tickets du ${formatDate(today)}`}
            description={`${totals.count} ticket(s) · ${formatEuro(totals.total)}${totals.byMethod.length ? " · " + totals.byMethod.map((m) => `${PAYMENT_METHOD_LABELS[m.method]} ${formatEuro(m.total)}`).join(", ") : ""}`}
          />
          {tickets.length === 0 ? (
            <CardBody className="text-[13px] text-foreground-muted">Aucun ticket aujourd&apos;hui.</CardBody>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <th className="px-5 py-2 font-medium">N°</th>
                  <th className="px-2 py-2 font-medium">Heure</th>
                  <th className="px-2 py-2 font-medium">Nature</th>
                  <th className="px-5 py-2 text-right font-medium">Total TTC</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-5 py-2 font-mono text-xs">
                      <Link href={`/caisse/tickets/${t.id}`} className="hover:text-accent">
                        {t.number}
                      </Link>
                    </td>
                    <td className="px-2 py-2">{time(t.recordedAt)}</td>
                    <td className="px-2 py-2">
                      {t.kind === "refund" ? <Badge tone="warning">Remboursement</Badge> : "Vente"} {t.training && <Badge tone="accent">École</Badge>}
                    </td>
                    <td className="tabular px-5 py-2 text-right font-medium">{formatEuro(t.totalInclTax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Session et journée" />
            <CardBody className="space-y-4">
              {openSession ? (
                <CloseSessionForm registerId={register.id} />
              ) : (
                <p className="text-[13px] text-foreground-muted">Aucune session ouverte.</p>
              )}
              {canClose && (
                <div className="flex flex-wrap items-start gap-2 border-t border-border pt-4">
                  <CloseDayButton registerId={register.id} disabled={!!openSession || dayClosed} />
                  <VerifyRegisterButton registerId={register.id} />
                </div>
              )}
              <p className="text-xs text-foreground-subtle">
                Les journées non clôturées le sont automatiquement au premier ticket du jour suivant ; les mois et exercices
                révolus aussi.
              </p>
            </CardBody>
          </Card>

          {sessions.length > 0 && (
            <Card>
              <CardHeader title="Sessions récentes" />
              <ul className="divide-y divide-border text-[13px]">
                {sessions.slice(0, 8).map((s) => (
                  <li key={s.id} className="flex justify-between gap-2 px-5 py-2">
                    <span>
                      {dateTime(s.openedAt)}
                      <span className="block text-xs text-foreground-muted">Fond {formatEuro(s.openingFloat)}</span>
                    </span>
                    {s.closedAt ? (
                      <span className="text-right">
                        Compté {formatEuro(s.countedCash!)}
                        <span className={`block text-xs ${s.difference && !s.difference.match(/^-?0\.00$/) ? "text-warning" : "text-foreground-muted"}`}>
                          Écart {formatEuro(s.difference!)}
                        </span>
                      </span>
                    ) : (
                      <Badge tone="success">En cours</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Clôtures" description="Chaînées et signées (Ed25519). Grand total de la période ; total perpétuel jamais remis à zéro." />
          {closures.length === 0 ? (
            <CardBody className="text-[13px] text-foreground-muted">Aucune clôture.</CardBody>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-foreground-muted">
                    <th className="px-5 py-2 font-medium">Rang</th>
                    <th className="px-2 py-2 font-medium">Période</th>
                    <th className="px-2 py-2 text-right font-medium">Tickets</th>
                    <th className="px-2 py-2 text-right font-medium">TVA</th>
                    <th className="px-2 py-2 text-right font-medium">Grand total</th>
                    <th className="px-5 py-2 text-right font-medium">Perpétuel</th>
                  </tr>
                </thead>
                <tbody>
                  {closures.map((c) => (
                    <tr key={c.id} className="border-b border-border last:border-0" title={`Empreinte ${c.hash}`}>
                      <td className="px-5 py-2 font-mono text-xs">{c.seq}</td>
                      <td className="px-2 py-2">
                        {CLOSURE_LABELS[c.kind]} {c.kind === "day" ? formatDate(c.periodStart) : `${formatDate(c.periodStart)} – ${formatDate(c.periodEnd)}`}
                      </td>
                      <td className="tabular px-2 py-2 text-right">{c.ticketCount}</td>
                      <td className="tabular px-2 py-2 text-right" title={Object.entries(c.vatBreakdown as Record<string, string>).filter(([k]) => k.endsWith(":tva")).map(([k, v]) => `${formatRate(k.split(":")[0]!)} : ${formatEuro(v)}`).join("\n")}>
                        {formatEuro(c.totalVat)}
                      </td>
                      <td className="tabular px-2 py-2 text-right font-medium">{formatEuro(c.grandTotal)}</td>
                      <td className="tabular px-5 py-2 text-right">{formatEuro(c.perpetualTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {canClose && (
          <Card>
            <CardHeader title="Archives" description="ZIP au format ouvert, avec notice, manifeste signé et clé publique." />
            <CardBody className="space-y-4">
              <form method="post" action={`/api/caisse/${register.id}/archive`} className="grid grid-cols-2 gap-3">
                <label className="text-xs text-foreground-muted">
                  Du
                  <Input name="from" type="date" required defaultValue={`${today.slice(0, 7)}-01`} className="mt-1" />
                </label>
                <label className="text-xs text-foreground-muted">
                  Au
                  <Input name="to" type="date" required defaultValue={today} className="mt-1" />
                </label>
                <Button type="submit" variant="secondary" className="col-span-2">
                  <Download className="size-3.5" aria-hidden /> Produire l&apos;archive
                </Button>
              </form>
              {archives.length > 0 && (
                <ul className="space-y-1 border-t border-border pt-3 text-xs text-foreground-muted">
                  {archives.slice(0, 6).map((a) => (
                    <li key={a.id} title={`SHA-256 ${a.sha256}`}>
                      {formatDate(a.periodStart)} – {formatDate(a.periodEnd)} · produite le {dateTime(a.createdAt)}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
