"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { postManualEntryAction } from "@/app/actions/accounting";
import { D, formatEuro } from "@/server/domain/money";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

interface ManualLine {
  key: string;
  account: string;
  accountLabel: string;
  auxNumber: string;
  label: string;
  debit: string;
  credit: string;
}

const emptyLine = (): ManualLine => ({ key: crypto.randomUUID(), account: "", accountLabel: "", auxNumber: "", label: "", debit: "", credit: "" });
const toNum = (v: string) => {
  const n = v.replace(/\s/g, "").replace(",", ".");
  return /^\d+(\.\d{1,2})?$/.test(n) ? new D(n) : new D(0);
};

/** Saisie d'une écriture d'opérations diverses (journal OD). */
export function ManualEntryForm({ accounts, parties, today }: { accounts: { number: string; label: string }[]; parties: { code: string; name: string }[]; today: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [head, setHead] = useState({ entryDate: today, pieceRef: "", label: "" });
  const [lines, setLines] = useState<ManualLine[]>(() => [emptyLine(), emptyLine()]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const debit = lines.reduce((a, l) => a.plus(toNum(l.debit)), new D(0));
  const credit = lines.reduce((a, l) => a.plus(toNum(l.credit)), new D(0));
  const balanced = debit.equals(credit) && debit.greaterThan(0);
  const update = (key: string, patch: Partial<ManualLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const known = (n: string) => accounts.find((a) => a.number === n);

  return (
    <form
      method="post"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          setError(null);
          const r = await postManualEntryAction({
            idempotencyKey,
            ...head,
            lines: lines
              .filter((l) => l.account || l.debit || l.credit)
              .map((l) => ({
                account: l.account,
                accountLabel: known(l.account) ? undefined : l.accountLabel || undefined,
                auxNumber: l.auxNumber || undefined,
                label: l.label || undefined,
                debit: l.debit,
                credit: l.credit,
              })),
          });
          if (!r.ok) {
            setError(r.fieldErrors ? `${r.error} ${Object.values(r.fieldErrors).join(" ")}` : r.error);
            return;
          }
          toast.success(r.message);
          setHead({ entryDate: today, pieceRef: "", label: "" });
          setLines([emptyLine(), emptyLine()]);
          setIdempotencyKey(crypto.randomUUID());
        });
      }}
    >
      {error && <FormAlert>{error}</FormAlert>}
      <div className="grid gap-3 sm:grid-cols-[10rem_10rem_1fr]">
        <Field label="Date" htmlFor="me-date" required>
          <Input id="me-date" type="date" max={today} value={head.entryDate} onChange={(e) => setHead((h) => ({ ...h, entryDate: e.target.value }))} />
        </Field>
        <Field label="Pièce" htmlFor="me-piece" required>
          <Input id="me-piece" maxLength={40} value={head.pieceRef} onChange={(e) => setHead((h) => ({ ...h, pieceRef: e.target.value }))} />
        </Field>
        <Field label="Libellé" htmlFor="me-label" required>
          <Input id="me-label" maxLength={200} value={head.label} onChange={(e) => setHead((h) => ({ ...h, label: e.target.value }))} />
        </Field>
      </div>
      <datalist id="me-accounts">
        {accounts.map((a) => (
          <option key={a.number} value={a.number}>
            {a.label}
          </option>
        ))}
      </datalist>
      <datalist id="me-parties">
        {parties.map((p) => (
          <option key={p.code} value={p.code}>
            {p.name}
          </option>
        ))}
      </datalist>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xs text-foreground-muted">
              <th className="py-1.5 pr-2 font-medium">Compte</th>
              <th className="py-1.5 pr-2 font-medium">Intitulé</th>
              <th className="py-1.5 pr-2 font-medium">Tiers</th>
              <th className="py-1.5 pr-2 font-medium">Libellé de ligne</th>
              <th className="py-1.5 pr-2 text-right font-medium">Débit</th>
              <th className="py-1.5 pr-2 text-right font-medium">Crédit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const acc = known(l.account);
              return (
                <tr key={l.key}>
                  <td className="py-1 pr-2">
                    <Input
                      aria-label={`Compte ligne ${i + 1}`}
                      list="me-accounts"
                      className="h-8 w-28 font-mono"
                      maxLength={6}
                      value={l.account}
                      onChange={(e) => update(l.key, { account: e.target.value.replace(/\D/g, "") })}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    {acc ? (
                      <span className="text-xs text-foreground-muted">{acc.label}</span>
                    ) : (
                      <Input
                        aria-label={`Intitulé du nouveau compte ligne ${i + 1}`}
                        placeholder={l.account.length === 6 ? "Nouveau compte : intitulé" : ""}
                        className="h-8"
                        value={l.accountLabel}
                        onChange={(e) => update(l.key, { accountLabel: e.target.value })}
                      />
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    <Input aria-label={`Tiers ligne ${i + 1}`} list="me-parties" className="h-8 w-24" value={l.auxNumber} onChange={(e) => update(l.key, { auxNumber: e.target.value })} />
                  </td>
                  <td className="py-1 pr-2">
                    <Input aria-label={`Libellé ligne ${i + 1}`} className="h-8" value={l.label} onChange={(e) => update(l.key, { label: e.target.value })} />
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      aria-label={`Débit ligne ${i + 1}`}
                      inputMode="decimal"
                      className="h-8 w-28 text-right"
                      value={l.debit}
                      onChange={(e) => update(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      aria-label={`Crédit ligne ${i + 1}`}
                      inputMode="decimal"
                      className="h-8 w-28 text-right"
                      value={l.credit}
                      onChange={(e) => update(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })}
                    />
                  </td>
                  <td className="py-1">
                    {lines.length > 2 && (
                      <button
                        type="button"
                        className="rounded p-1 text-foreground-subtle hover:bg-muted hover:text-danger"
                        aria-label={`Supprimer la ligne ${i + 1}`}
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td colSpan={4} className="py-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
                  <Plus className="size-3.5" aria-hidden /> Ajouter une ligne
                </Button>
              </td>
              <td className="tabular py-2 pr-2 text-right">{formatEuro(debit)}</td>
              <td className="tabular py-2 pr-2 text-right">{formatEuro(credit)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} disabled={!balanced || !head.pieceRef.trim() || head.label.trim().length < 3}>
          Enregistrer l&apos;écriture
        </Button>
        <span className={`text-[13px] ${balanced ? "text-success" : "text-foreground-muted"}`}>
          {balanced ? "Écriture équilibrée." : `Écart : ${formatEuro(debit.minus(credit).abs())}`}
        </span>
      </div>
      <p className="text-xs text-foreground-subtle">
        L&apos;écriture est validée dès son enregistrement et ne pourra plus être modifiée : une erreur se corrige par une écriture inverse.
      </p>
    </form>
  );
}
