import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { invoiceBalances } from "@/server/services/payments";
import { listCustomerOptions } from "@/server/services/sales";
import { treasuryAccountOptions } from "@/server/services/treasury";
import { todayInParis } from "@/server/domain/numbering";
import { PaymentForm } from "./payment-form";

export const metadata: Metadata = { title: "Nouveau règlement" };

export default async function NewPaymentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const { ctx } = await requirePermission("payments.write");
  const db = await getDb();
  const kind = params.type === "remboursement" ? "refund" : "receipt";
  const [customers, accounts] = await Promise.all([listCustomerOptions(db, ctx), treasuryAccountOptions(db, ctx)]);
  const clientId = customers.find((c) => c.id === params.client)?.id ?? "";
  const balances = clientId ? await invoiceBalances(db, ctx, { thirdPartyId: clientId }) : [];
  const open = balances.filter((b) => (kind === "receipt" ? Number(b.remaining) > 0 : Number(b.remaining) < 0));

  return (
    <>
      <PageHeader
        title={kind === "refund" ? "Remboursement" : "Encaissement"}
        description={
          kind === "refund"
            ? "Remboursement d'un trop-perçu (par exemple après un avoir sur une facture déjà réglée)."
            : "Le règlement est imputé sur une ou plusieurs factures. Un montant non imputé reste disponible pour le client."
        }
      />
      <PaymentForm
        kind={kind}
        today={todayInParis()}
        accounts={accounts.map((a) => ({ id: a.id, label: a.name, kind: a.kind, isDefault: a.isDefault }))}
        customers={customers.map((c) => ({ id: c.id, label: `${c.name} (${c.code})` }))}
        clientId={clientId}
        invoices={open.map((b) => ({
          id: b.id,
          number: b.number,
          issueDate: b.issueDate,
          dueDate: b.dueDate,
          netDue: b.netDue,
          open: kind === "receipt" ? b.remaining : (-Number(b.remaining)).toFixed(2),
          status: b.status,
        }))}
        preselectedInvoiceId={open.some((b) => b.id === params.facture) ? params.facture! : null}
      />
    </>
  );
}
