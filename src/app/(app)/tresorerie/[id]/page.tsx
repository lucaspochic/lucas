import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, CheckCheck } from "lucide-react";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { orNotFound, requirePermission } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { getBankAccount, listReconciled, listUnreconciled } from "@/server/services/treasury";
import { formatEuro } from "@/server/domain/money";
import { formatDate } from "../../ventes/sales-ui";
import { ReconcileButtons, UnreconcileButton } from "../treasury-client";
import { StatementImport } from "./statement-import";

export const metadata: Metadata = { title: "Compte bancaire" };

export default async function BankAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requirePermission("treasury.read");
  const db = await getDb();
  const account = await orNotFound(getBankAccount(db, ctx, id));
  const [open, done] = await Promise.all([listUnreconciled(db, ctx, id), listReconciled(db, ctx, id)]);
  const canWrite = can(ctx, "treasury.write");

  return (
    <>
      <Link href="/tresorerie" className="mb-3 inline-flex items-center gap-1 text-[13px] text-foreground-muted hover:text-foreground">
        <ChevronLeft className="size-4" aria-hidden /> Trésorerie
      </Link>
      <PageHeader title={account.name} description={`Compte ${account.ledgerAccount} — relevés et rapprochement`} />
      <div className="space-y-6">
        {canWrite && account.kind === "bank" && (
          <Card>
            <CardHeader
              title="Importer un relevé"
              description="CSV exporté depuis votre banque : colonnes date, libellé et montant (ou débit / crédit). Un relevé déjà importé n'est jamais dupliqué."
            />
            <CardBody>
              <StatementImport accountId={account.id} />
            </CardBody>
          </Card>
        )}
        <Card>
          <CardHeader title="À rapprocher" description="Associez chaque ligne du relevé au règlement enregistré correspondant (même montant, à ±10 jours)." />
          {open.length === 0 ? (
            <EmptyState icon={<CheckCheck className="size-5" aria-hidden />} title="Tout est rapproché" description="Aucune ligne de relevé en attente." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-foreground-muted">
                    <th className="px-5 py-2.5 font-medium">Date</th>
                    <th className="px-5 py-2.5 font-medium">Libellé</th>
                    <th className="px-5 py-2.5 text-right font-medium">Montant</th>
                    <th className="px-5 py-2.5 text-right font-medium">Correspondance</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((l) => (
                    <tr key={l.id} className="border-b border-border last:border-0">
                      <td className="tabular whitespace-nowrap px-5 py-2.5 text-foreground-muted">{formatDate(l.operationDate)}</td>
                      <td className="px-5 py-2.5">{l.label}</td>
                      <td className={`tabular whitespace-nowrap px-5 py-2.5 text-right font-medium ${l.amount.startsWith("-") ? "text-danger" : "text-success"}`}>
                        {formatEuro(l.amount)}
                      </td>
                      <td className="px-5 py-2">
                        {canWrite ? (
                          <ReconcileButtons
                            transactionId={l.id}
                            candidates={l.candidates.map((c) => ({ type: c.type, id: c.id, number: c.number, party: c.party, date: c.date }))}
                          />
                        ) : (
                          <span className="text-xs text-foreground-subtle">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {done.length > 0 && (
          <Card>
            <CardHeader title="Derniers rapprochements" />
            <ul className="divide-y divide-border text-[13px]">
              {done.map((l) => (
                <li key={l.id} className="flex items-center gap-4 px-5 py-2.5">
                  <span className="tabular w-24 text-foreground-muted">{formatDate(l.operationDate)}</span>
                  <span className="flex-1 truncate">{l.label}</span>
                  <span className="font-mono text-xs text-foreground-muted">{l.paymentNumber ?? l.expensePaymentNumber}</span>
                  <span className="tabular w-28 text-right">{formatEuro(l.amount)}</span>
                  {canWrite && <UnreconcileButton transactionId={l.id} />}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
