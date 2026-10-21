"use client";

import { useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { recordPaymentAction } from "@/app/actions/payments";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@/lib/schemas";
import { D, dec, formatEuro } from "@/server/domain/money";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";
import { FileText } from "lucide-react";

interface OpenInvoice {
  id: string;
  number: string;
  issueDate: string;
  dueDate: string | null;
  netDue: string;
  /** Reste à payer (encaissement) ou trop-perçu (remboursement), positif. */
  open: string;
  status: string;
}

const toNumberText = (v: string) => v.replace(/[\s  €]/g, "").replace(",", ".");
const safeDec = (v: string) => {
  const t = toNumberText(v);
  return /^\d+(\.\d{1,2})?$/.test(t) ? dec(t) : null;
};
const fmtDate = (iso: string) => iso.split("-").reverse().join("/");

export function PaymentForm({
  kind,
  today,
  customers,
  clientId,
  invoices,
  preselectedInvoiceId,
  accounts,
}: {
  kind: "receipt" | "refund";
  today: string;
  customers: { id: string; label: string }[];
  clientId: string;
  invoices: OpenInvoice[];
  preselectedInvoiceId: string | null;
  accounts: { id: string; label: string; kind: "bank" | "cash"; isDefault: boolean }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Clé d'idempotence fixée à l'ouverture du formulaire : un double envoi n'enregistre qu'un règlement.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const pre = invoices.find((i) => i.id === preselectedInvoiceId);
  const [amount, setAmount] = useState(pre ? pre.open.replace(".", ",") : "");
  const [allocs, setAllocs] = useState<Record<string, string>>(pre ? { [pre.id]: pre.open.replace(".", ",") } : {});
  const [paymentDate, setPaymentDate] = useState(today);
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>("transfer");
  const [reference, setReference] = useState("");
  const [accountId, setAccountId] = useState("");
  const accountOptions = accounts.filter((a) => a.kind === (method === "cash" ? "cash" : "bank"));

  const totals = useMemo(() => {
    const allocated = Object.values(allocs).reduce((acc, v) => acc.plus(safeDec(v) ?? new D(0)), new D(0));
    const amt = safeDec(amount);
    return { allocated, amt, unallocated: amt ? amt.minus(allocated) : null };
  }, [allocs, amount]);

  const changeClient = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("client", id);
    else params.delete("client");
    params.delete("facture");
    router.replace(`${pathname}?${params}`);
  };

  /** Répartit le montant sur les factures, de la plus ancienne à la plus récente. */
  const distribute = () => {
    let left = totals.amt ?? new D(0);
    const next: Record<string, string> = {};
    for (const inv of invoices) {
      if (left.lte(0)) break;
      const take = D.min(left, dec(inv.open));
      next[inv.id] = take.toFixed(2).replace(".", ",");
      left = left.minus(take);
    }
    setAllocs(next);
  };

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = await recordPaymentAction({
        idempotencyKey,
        kind,
        thirdPartyId: clientId,
        paymentDate,
        method,
        amount: toNumberText(amount),
        reference,
        bankAccountId: accountId || null,
        allocations: Object.entries(allocs).map(([documentId, v]) => ({ documentId, amount: toNumberText(v) || "0" })),
      });
      if (!result.ok) return setError(result.error);
      toast.success(result.message);
      router.push(`/reglements/${result.data!.id}`);
    });

  const over = totals.unallocated?.isNegative();
  return (
    <form
      method="post"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-6"
    >
      {error && <FormAlert>{error}</FormAlert>}
      <Card>
        <CardHeader title="Règlement" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Client" htmlFor="client" required>
            <Select id="client" value={clientId} onChange={(e) => changeClient(e.target.value)}>
              <option value="">— Choisir un client —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date du paiement" htmlFor="paymentDate" required hint="Date de réception (ou du chèque) ; jamais dans le futur.">
            <Input id="paymentDate" type="date" max={today} value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
          </Field>
          <Field label="Montant (€)" htmlFor="amount" required>
            <Input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" />
          </Field>
          <Field label="Mode de paiement" htmlFor="method" required>
            <Select
              id="method"
              value={method}
              onChange={(e) => {
                setMethod(e.target.value as typeof method);
                setAccountId("");
              }}
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Compte de trésorerie" htmlFor="account" hint="Espèces : caisse ; autres modes : compte bancaire.">
            <Select id="account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Par défaut ({accountOptions.find((a) => a.isDefault)?.label ?? "aucun"})</option>
              {accountOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Référence" htmlFor="reference" hint="N° de chèque, référence du virement…">
            <Input id="reference" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </CardBody>
      </Card>

      {clientId && (
        <Card>
          <CardHeader
            title={kind === "refund" ? "Factures en trop-perçu" : "Imputation sur les factures"}
            description={kind === "refund" ? "Le remboursement doit être entièrement imputé." : "Laissez à zéro les factures non concernées."}
            actions={
              invoices.length > 0 && totals.amt ? (
                <Button type="button" size="sm" variant="secondary" onClick={distribute}>
                  Répartir automatiquement
                </Button>
              ) : undefined
            }
          />
          {invoices.length === 0 ? (
            <EmptyState
              icon={<FileText className="size-5" aria-hidden />}
              title={kind === "refund" ? "Aucun trop-perçu" : "Aucune facture à régler"}
              description={kind === "refund" ? "Aucune facture de ce client n'a été payée au-delà de son montant." : "Le règlement sera enregistré sans imputation (acompte client)."}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-foreground-muted">
                    <th className="px-5 py-2.5 font-medium">Facture</th>
                    <th className="px-5 py-2.5 font-medium">Échéance</th>
                    <th className="px-5 py-2.5 text-right font-medium">{kind === "refund" ? "Trop-perçu" : "Reste à payer"}</th>
                    <th className="w-44 px-5 py-2.5 text-right font-medium">Montant imputé</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-b border-border last:border-0">
                      <td className="px-5 py-2.5 font-mono text-xs">{inv.number}</td>
                      <td className={`tabular px-5 py-2.5 ${inv.status === "overdue" ? "text-danger" : "text-foreground-muted"}`}>
                        {inv.dueDate ? fmtDate(inv.dueDate) : "—"}
                      </td>
                      <td className="tabular px-5 py-2.5 text-right">{formatEuro(inv.open)}</td>
                      <td className="px-5 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            className="text-xs font-medium text-accent hover:underline"
                            onClick={() => setAllocs((s) => ({ ...s, [inv.id]: inv.open.replace(".", ",") }))}
                          >
                            Solder
                          </button>
                          <Input
                            aria-label={`Montant imputé sur ${inv.number}`}
                            inputMode="decimal"
                            className="h-8 w-28 text-right"
                            value={allocs[inv.id] ?? ""}
                            placeholder="0,00"
                            onChange={(e) => setAllocs((s) => ({ ...s, [inv.id]: e.target.value }))}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <CardBody className="flex justify-end gap-6 border-t border-border text-[13px]">
            <span className="text-foreground-muted">
              Imputé : <span className="tabular font-medium text-foreground">{formatEuro(totals.allocated)}</span>
            </span>
            {totals.unallocated && (
              <span className={over ? "text-danger" : "text-foreground-muted"}>
                {over ? "Dépassement : " : "Non imputé : "}
                <span className="tabular font-medium">{formatEuro(totals.unallocated.abs())}</span>
              </span>
            )}
          </CardBody>
        </Card>
      )}

      <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
        <Button type="submit" loading={pending} disabled={!clientId || !totals.amt || totals.amt.isZero() || over}>
          {kind === "refund" ? "Enregistrer le remboursement" : "Enregistrer l'encaissement"}
        </Button>
      </div>
    </form>
  );
}
