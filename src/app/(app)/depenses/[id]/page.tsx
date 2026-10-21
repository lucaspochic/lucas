import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { orNotFound, requirePermission } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { getExpense, listSupplierOptions } from "@/server/services/expenses";
import { treasuryAccountOptions } from "@/server/services/treasury";
import { dec, formatEuro, formatRate } from "@/server/domain/money";
import { todayInParis } from "@/server/domain/numbering";
import { EXPENSE_CATEGORIES, PAYMENT_METHOD_LABELS, type ExpenseCategory } from "@/lib/schemas";
import { formatDateTime } from "@/lib/utils";
import { formatDate } from "../../ventes/sales-ui";
import { ExpenseEditor } from "../expense-editor";
import { DraftExpenseActions, ExpensePaymentForm, ReverseExpensePaymentButton } from "./expense-actions";
import { AttachmentsPanel } from "@/components/attachments/attachments-panel";

export const metadata: Metadata = { title: "Dépense" };

const editable = (v: string) => v.replace(".", ",");

export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requirePermission("purchases.read");
  const db = await getDb();
  const { expense: e, partyName, partyCode, lines, payments } = await orNotFound(getExpense(db, ctx, id));
  const canWrite = can(ctx, "purchases.write");
  const back = (
    <Link href="/depenses" className="mb-3 inline-flex items-center gap-1 text-[13px] text-foreground-muted hover:text-foreground">
      <ChevronLeft className="size-4" aria-hidden /> Dépenses
    </Link>
  );

  if (e.status === "draft") {
    const suppliers = await listSupplierOptions(db, ctx);
    return (
      <>
        {back}
        <PageHeader
          title="Dépense — brouillon"
          description={`Créée le ${formatDateTime(e.createdAt)}. Aucun numéro avant la validation.`}
          actions={canWrite ? <DraftExpenseActions id={e.id} /> : undefined}
        />
        {canWrite ? (
          <ExpenseEditor
            expenseId={e.id}
            suppliers={suppliers.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
            defaults={{
              thirdPartyId: e.thirdPartyId,
              supplierReference: e.supplierReference ?? "",
              invoiceDate: e.invoiceDate,
              dueDate: e.dueDate ?? "",
              notes: e.notes ?? "",
              lines: lines.map((l) => ({
                category: l.category as ExpenseCategory,
                description: l.description,
                amountExclTax: editable(l.amountExclTax),
                vatRate: dec(l.vatRate).toString() as "20",
                vatAmount: editable(l.vatAmount),
              })),
            }}
          />
        ) : (
          <Card>
            <CardBody className="text-[13px] text-foreground-muted">Brouillon en cours de saisie.</CardBody>
          </Card>
        )}
        <div className="mt-6 max-w-3xl">
          <AttachmentsPanel ctx={ctx} entityType="expense" entityId={e.id} path={`/depenses/${e.id}`} />
        </div>
      </>
    );
  }

  const remaining = dec(e.totalInclTax).minus(e.amountPaid);
  const accounts = canWrite ? await treasuryAccountOptions(db, ctx) : [];
  const reversed = new Set(payments.filter((p) => p.reversesId).map((p) => p.reversesId));
  return (
    <>
      {back}
      <PageHeader
        title={`Dépense ${e.number}`}
        description={`${partyName} (${partyCode})${e.supplierReference ? ` — facture ${e.supplierReference}` : ""} — validée le ${formatDateTime(e.validatedAt!)}`}
        actions={remaining.lte(0) ? <Badge tone="success">Payée</Badge> : <Badge tone="accent">À payer : {formatEuro(remaining)}</Badge>}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="Détail" description={`Facture du ${formatDate(e.invoiceDate)} — échéance ${e.dueDate ? formatDate(e.dueDate) : "—"}`} />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <th className="px-5 py-2.5 font-medium">Catégorie</th>
                  <th className="px-5 py-2.5 font-medium">Libellé</th>
                  <th className="px-5 py-2.5 text-right font-medium">HT</th>
                  <th className="px-5 py-2.5 text-right font-medium">TVA</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-2.5">
                      {EXPENSE_CATEGORIES[l.category as ExpenseCategory]?.label ?? l.category}
                      <span className="ml-1 font-mono text-[11px] text-foreground-subtle">{l.ledgerAccount}</span>
                    </td>
                    <td className="px-5 py-2.5">{l.description}</td>
                    <td className="tabular px-5 py-2.5 text-right">{formatEuro(l.amountExclTax)}</td>
                    <td className="tabular whitespace-nowrap px-5 py-2.5 text-right">
                      {formatEuro(l.vatAmount)} <span className="text-foreground-subtle">({formatRate(l.vatRate)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CardBody className="flex justify-end gap-6 border-t border-border text-[13px]">
            <span>HT {formatEuro(e.totalExclTax)}</span>
            <span>TVA {formatEuro(e.totalVat)}</span>
            <span className="font-semibold">TTC {formatEuro(e.totalInclTax)}</span>
          </CardBody>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Paiements" />
            {payments.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-foreground-muted">Aucun paiement.</p>
            ) : (
              <ul className="divide-y divide-border text-[13px]">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-5 py-2.5">
                    <span>
                      <span className="block font-mono text-xs">{p.number}</span>
                      <span className="block text-foreground-muted">
                        {formatDate(p.paymentDate)} · {PAYMENT_METHOD_LABELS[p.method]}
                        {p.reason ? ` · ${p.reason}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={`tabular ${p.amount.startsWith("-") ? "text-danger" : ""}`}>{formatEuro(p.amount)}</span>
                      {canWrite && !p.reversesId && !reversed.has(p.id) && <ReverseExpensePaymentButton paymentId={p.id} number={p.number} />}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {canWrite && remaining.greaterThan(0) && (
            <ExpensePaymentForm
              expenseId={e.id}
              remaining={remaining.toFixed(2)}
              today={todayInParis()}
              accounts={accounts.map((a) => ({ id: a.id, label: a.name, kind: a.kind, isDefault: a.isDefault }))}
            />
          )}
        </div>
      </div>
      <div className="mt-6 max-w-3xl">
        <AttachmentsPanel ctx={ctx} entityType="expense" entityId={e.id} path={`/depenses/${e.id}`} />
      </div>
    </>
  );
}
