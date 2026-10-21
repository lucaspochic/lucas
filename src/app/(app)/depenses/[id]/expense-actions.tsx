"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { deleteExpenseAction, payExpenseAction, reverseExpensePaymentAction, validateExpenseAction } from "@/app/actions/purchases";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

export function DraftExpenseActions({ id }: { id: string }) {
  const router = useRouter();
  return (
    <>
      <ConfirmDialog
        trigger={
          <Button variant="ghost">
            <Trash2 className="size-4" aria-hidden /> Supprimer
          </Button>
        }
        title="Supprimer ce brouillon ?"
        description="La suppression est tracée dans le journal d'audit."
        confirmLabel="Supprimer"
        tone="danger"
        onConfirm={async () => {
          const r = await deleteExpenseAction(id);
          if (r && !r.ok) toast.error(r.error);
        }}
      />
      <ConfirmDialog
        trigger={
          <Button>
            <CheckCheck className="size-4" aria-hidden /> Valider
          </Button>
        }
        title="Valider la dépense ?"
        description="Elle reçoit un numéro interne et ne pourra plus être modifiée ni supprimée. Vérifiez les montants avec la facture du fournisseur."
        confirmLabel="Valider"
        onConfirm={async () => {
          const r = await validateExpenseAction(id);
          if (!r.ok) {
            toast.error(r.error);
            return false;
          }
          toast.success(r.message);
          router.refresh();
        }}
      />
    </>
  );
}

export function ExpensePaymentForm({
  expenseId,
  remaining,
  today,
  accounts,
}: {
  expenseId: string;
  remaining: string;
  today: string;
  accounts: { id: string; label: string; kind: "bank" | "cash"; isDefault: boolean }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Nouvelle clé après chaque paiement réussi : le formulaire reste affiché pour un éventuel second paiement.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>("transfer");
  const kind = method === "cash" ? "cash" : "bank";
  const options = accounts.filter((a) => a.kind === kind);
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState(remaining.replace(".", ","));
  const [paymentDate, setPaymentDate] = useState(today);
  const [reference, setReference] = useState("");

  return (
    <Card>
      <CardHeader title="Enregistrer un paiement" />
      <CardBody>
        <form
          method="post"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              setError(null);
              const r = await payExpenseAction(expenseId, {
                idempotencyKey,
                bankAccountId: accountId || null,
                paymentDate,
                method,
                amount: amount.replace(/\s/g, "").replace(",", "."),
                reference,
              });
              if (!r.ok) return setError(r.error);
              toast.success(r.message);
              setIdempotencyKey(crypto.randomUUID());
              router.refresh();
            });
          }}
        >
          {error && <FormAlert>{error}</FormAlert>}
          <Field label="Montant (€)" htmlFor="pay-amount">
            <Input id="pay-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Date" htmlFor="pay-date">
            <Input id="pay-date" type="date" max={today} value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
          </Field>
          <Field label="Mode" htmlFor="pay-method">
            <Select
              id="pay-method"
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
          <Field label="Compte" htmlFor="pay-account">
            <Select id="pay-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Par défaut ({options.find((a) => a.isDefault)?.label ?? "—"})</option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Référence" htmlFor="pay-ref">
            <Input id="pay-ref" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" loading={pending}>
            Enregistrer le paiement
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function ReverseExpensePaymentButton({ paymentId, number }: { paymentId: string; number: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  return (
    <ConfirmDialog
      trigger={
        <button type="button" className="rounded p-1 text-foreground-subtle hover:bg-muted hover:text-danger" aria-label={`Contre-passer ${number}`}>
          <Undo2 className="size-3.5" />
        </button>
      }
      title={`Contre-passer le paiement ${number} ?`}
      description={
        <span className="block space-y-2">
          <span className="block">Un paiement de montant opposé est enregistré ; l&apos;original reste visible.</span>
          <label className="block text-[13px] font-medium text-foreground" htmlFor={`reason-${paymentId}`}>
            Motif (obligatoire)
          </label>
          <Textarea id={`reason-${paymentId}`} rows={2} value={reason} aria-invalid={!!error} onChange={(e) => { setReason(e.target.value); setError(null); }} />
          {error && (
            <span role="alert" className="block text-xs text-danger">
              {error}
            </span>
          )}
        </span>
      }
      confirmLabel="Contre-passer"
      tone="danger"
      onConfirm={async () => {
        const r = await reverseExpensePaymentAction(paymentId, { idempotencyKey, reason });
        if (!r.ok) {
          setError(r.fieldErrors?.reason ?? r.error);
          return false;
        }
        toast.success(r.message);
        router.refresh();
      }}
    />
  );
}
