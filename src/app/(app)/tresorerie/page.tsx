import type { Metadata } from "next";
import Link from "next/link";
import { Landmark, Wallet } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { accountBalances, cashForecast } from "@/server/services/treasury";
import { D, dec, formatEuro } from "@/server/domain/money";
import { formatDate } from "../ventes/sales-ui";
import { NewBankAccountForm, SetDefaultButton } from "./treasury-client";

export const metadata: Metadata = { title: "Trésorerie" };

export default async function TreasuryPage() {
  const { ctx } = await requirePermission("treasury.read");
  const db = await getDb();
  const [accounts, forecast] = await Promise.all([accountBalances(db, ctx), cashForecast(db, ctx)]);
  const total = accounts.reduce((acc, a) => acc.plus(a.bookBalance), new D(0));
  const canWrite = can(ctx, "treasury.write");

  return (
    <>
      <PageHeader
        title="Trésorerie"
        description="Soldes des comptes, relevés bancaires, rapprochement et prévision."
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader
              title="Comptes"
              description={`Solde comptable total : ${formatEuro(total)} — ouverture + règlements clients − paiements fournisseurs enregistrés.`}
            />
            <ul className="divide-y divide-border">
              {accounts.map((a) => {
                const gap = a.statementBalance !== null ? dec(a.bookBalance).minus(a.statementBalance) : null;
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                    <div className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground-muted">
                      {a.kind === "bank" ? <Landmark className="size-4" aria-hidden /> : <Wallet className="size-4" aria-hidden />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {a.kind === "bank" ? (
                          <Link href={`/tresorerie/${a.id}`} className="hover:text-accent">
                            {a.name}
                          </Link>
                        ) : (
                          a.name
                        )}
                        {a.isDefault && <Badge>Par défaut</Badge>}
                      </p>
                      <p className="text-xs text-foreground-muted">
                        Compte {a.ledgerAccount}
                        {a.iban ? ` · ${a.iban.replace(/(.{4})/g, "$1 ").trim()}` : ""}
                      </p>
                    </div>
                    <div className="text-right text-[13px]">
                      <p className="tabular text-base font-semibold">{formatEuro(a.bookBalance)}</p>
                      {a.statementBalance !== null ? (
                        <p className="text-xs text-foreground-muted">
                          Relevé au {formatDate(a.lastStatementDate!)} : {formatEuro(a.statementBalance)}
                          {gap && !gap.isZero() && <span className="text-warning"> (écart {formatEuro(gap)})</span>}
                        </p>
                      ) : (
                        a.kind === "bank" && <p className="text-xs text-foreground-subtle">Aucun relevé importé</p>
                      )}
                      {a.unreconciled > 0 && (
                        <Link href={`/tresorerie/${a.id}`} className="text-xs font-medium text-accent hover:underline">
                          {a.unreconciled} opération(s) à rapprocher
                        </Link>
                      )}
                    </div>
                    {canWrite && !a.isDefault && <SetDefaultButton id={a.id} />}
                  </li>
                );
              })}
            </ul>
          </Card>
          {canWrite && <NewBankAccountForm />}
        </div>

        <Card>
          <CardHeader title="Prévision" description="Créances clients et dépenses à payer, par échéance." />
          <CardBody className="space-y-4 text-[13px]">
            {(dec(forecast.overdue.incoming).greaterThan(0) || dec(forecast.overdue.outgoing).greaterThan(0)) && (
              <div className="rounded-md bg-warning-soft px-3 py-2 text-warning">
                Échu : {formatEuro(forecast.overdue.incoming)} à encaisser, {formatEuro(forecast.overdue.outgoing)} à payer.
              </div>
            )}
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-foreground-muted">
                  <th className="py-1.5 font-medium">Horizon</th>
                  <th className="py-1.5 text-right font-medium">Entrées</th>
                  <th className="py-1.5 text-right font-medium">Sorties</th>
                  <th className="py-1.5 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {forecast.horizons.map((hz) => (
                  <tr key={hz.days} className="border-t border-border">
                    <td className="py-2">{hz.days} jours</td>
                    <td className="tabular py-2 text-right text-success">+{formatEuro(hz.incoming)}</td>
                    <td className="tabular py-2 text-right text-danger">-{formatEuro(hz.outgoing)}</td>
                    <td className={`tabular py-2 text-right font-medium ${hz.net.startsWith("-") ? "text-danger" : ""}`}>{formatEuro(hz.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-foreground-subtle">
              Inclut les montants déjà échus. Solde prévisionnel = solde comptable + net de l&apos;horizon (
              {formatEuro(total.plus(forecast.horizons[0]!.net))} à 30 jours).
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
