"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Link2Off } from "lucide-react";
import { toast } from "sonner";
import { createBankAccountAction, reconcileAction, setDefaultBankAccountAction, unreconcileAction } from "@/app/actions/treasury";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

export function SetDefaultButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await setDefaultBankAccountAction(id);
          if (r.ok) toast.success(r.message);
          else toast.error(r.error);
        })
      }
    >
      Définir par défaut
    </Button>
  );
}

export function NewBankAccountForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [v, setV] = useState({ kind: "bank", name: "", bankName: "", iban: "", openingBalance: "0", openingDate: new Date().toISOString().slice(0, 10), ledgerAccount: "512100" });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  return (
    <Card>
      <CardHeader title="Ajouter un compte" description="Second compte bancaire, livret, caisse supplémentaire…" />
      <CardBody>
        <form
          method="post"
          className="grid gap-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              setError(null);
              const r = await createBankAccountAction(v);
              if (!r.ok) {
                setError(r.error);
                setFieldErrors(r.fieldErrors ?? {});
                return;
              }
              toast.success(r.message);
              setFieldErrors({});
              router.refresh();
            });
          }}
        >
          {error && (
            <div className="sm:col-span-3">
              <FormAlert>{error}</FormAlert>
            </div>
          )}
          <Field label="Type" htmlFor="ba-kind">
            <Select
              id="ba-kind"
              value={v.kind}
              onChange={(e) => setV((s) => ({ ...s, kind: e.target.value, ledgerAccount: e.target.value === "bank" ? "512100" : "530100" }))}
            >
              <option value="bank">Compte bancaire</option>
              <option value="cash">Caisse espèces</option>
            </Select>
          </Field>
          <Field label="Nom" htmlFor="ba-name" error={fieldErrors.name}>
            <Input id="ba-name" value={v.name} onChange={set("name")} />
          </Field>
          <Field label="Compte comptable" htmlFor="ba-ledger" error={fieldErrors.ledgerAccount}>
            <Input id="ba-ledger" value={v.ledgerAccount} onChange={set("ledgerAccount")} />
          </Field>
          {v.kind === "bank" && (
            <>
              <Field label="Banque" htmlFor="ba-bank">
                <Input id="ba-bank" value={v.bankName} onChange={set("bankName")} />
              </Field>
              <Field label="IBAN" htmlFor="ba-iban" error={fieldErrors.iban} className="sm:col-span-2">
                <Input id="ba-iban" value={v.iban} onChange={set("iban")} />
              </Field>
            </>
          )}
          <Field label="Solde d'ouverture (€)" htmlFor="ba-open" error={fieldErrors.openingBalance}>
            <Input id="ba-open" inputMode="decimal" value={v.openingBalance} onChange={set("openingBalance")} />
          </Field>
          <Field label="À la date du" htmlFor="ba-date" error={fieldErrors.openingDate}>
            <Input id="ba-date" type="date" value={v.openingDate} onChange={set("openingDate")} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" loading={pending}>
              Créer le compte
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function ReconcileButtons({
  transactionId,
  candidates,
}: {
  transactionId: string;
  candidates: { type: "payment" | "expense_payment"; id: string; number: string; party: string; date: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState(candidates[0] ? `${candidates[0].type}:${candidates[0].id}` : "");
  if (candidates.length === 0) return <span className="text-xs text-foreground-subtle">Aucun règlement correspondant</span>;
  return (
    <span className="flex items-center justify-end gap-2">
      {candidates.length > 1 ? (
        <Select aria-label="Règlement à rapprocher" className="h-8 w-56 text-xs" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {candidates.map((c) => (
            <option key={c.id} value={`${c.type}:${c.id}`}>
              {c.number} — {c.party}
            </option>
          ))}
        </Select>
      ) : (
        <span className="text-xs text-foreground-muted">
          {candidates[0]!.number} — {candidates[0]!.party}
        </span>
      )}
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const [type, id] = choice.split(":") as ["payment" | "expense_payment", string];
            const r = await reconcileAction(transactionId, type, id);
            if (r.ok) toast.success(r.message);
            else toast.error(r.error);
          })
        }
      >
        <Link2 className="size-3.5" aria-hidden /> Rapprocher
      </Button>
    </span>
  );
}

export function UnreconcileButton({ transactionId }: { transactionId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await unreconcileAction(transactionId);
          if (r.ok) toast.success(r.message);
          else toast.error(r.error);
        })
      }
      className="rounded p-1 text-foreground-subtle hover:bg-muted hover:text-danger"
      aria-label="Annuler le rapprochement"
    >
      <Link2Off className="size-3.5" />
    </button>
  );
}
