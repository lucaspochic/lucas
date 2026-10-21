"use client";

import { useMemo, useState, useTransition } from "react";
import { Link2, Link2Off, Lock, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { autoLetterAction, closeFiscalYearAction, letterLinesAction, unletterAction } from "@/app/actions/accounting";
import { D, formatEuro } from "@/server/domain/money";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function AutoLetterButton() {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await autoLetterAction();
          if (r.ok) toast.success(r.message);
          else toast.error(r.error);
        })
      }
    >
      <Wand2 className="size-3.5" aria-hidden /> Lettrage automatique
    </Button>
  );
}

interface Line {
  id: string;
  entryDate: string;
  journalCode: string;
  entrySeq: number;
  fiscalYear: number;
  pieceRef: string;
  label: string;
  debit: string;
  credit: string;
  letteringId: string | null;
  code: string | null;
}

const amount = (v: string) => (v === "0.00" ? "" : formatEuro(v));
const date = (iso: string) => iso.split("-").reverse().join("/");

/** Lignes d'un compte de tiers : sélection des lignes non lettrées, lettrage, délettrage. */
export function LetteringTable({ lines, canWrite }: { lines: Line[]; canWrite: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const balance = useMemo(
    () => lines.filter((l) => selected.has(l.id)).reduce((a, l) => a.plus(l.debit).minus(l.credit), new D(0)),
    [lines, selected],
  );
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message);
        setSelected(new Set());
      } else toast.error(r.error);
    });

  return (
    <>
      {canWrite && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 text-[13px]">
          <span className="text-foreground-muted">
            {selected.size} ligne(s) sélectionnée(s) · solde{" "}
            <span className={`tabular font-medium ${balance.isZero() ? "text-success" : "text-foreground"}`}>{formatEuro(balance)}</span>
          </span>
          <Button size="sm" disabled={selected.size < 2 || !balance.isZero()} loading={pending} onClick={() => run(() => letterLinesAction([...selected]))}>
            <Link2 className="size-3.5" aria-hidden /> Lettrer la sélection
          </Button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-foreground-muted">
              {canWrite && <th className="w-10 px-5 py-2.5" />}
              <th className="px-2 py-2.5 font-medium">Date</th>
              <th className="px-2 py-2.5 font-medium">Pièce</th>
              <th className="px-2 py-2.5 font-medium">Libellé</th>
              <th className="px-2 py-2.5 text-right font-medium">Débit</th>
              <th className="px-2 py-2.5 text-right font-medium">Crédit</th>
              <th className="px-5 py-2.5 text-right font-medium">Lettrage</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const firstOfGroup = l.letteringId && lines.findIndex((x) => x.letteringId === l.letteringId) === i;
              return (
                <tr key={l.id} className={`border-b border-border last:border-0 ${l.code ? "text-foreground-muted" : ""}`}>
                  {canWrite && (
                    <td className="px-5 py-2">
                      {!l.code && (
                        <input
                          type="checkbox"
                          aria-label={`Sélectionner ${l.pieceRef}`}
                          checked={selected.has(l.id)}
                          onChange={() => toggle(l.id)}
                          className="size-4 accent-[var(--color-accent)]"
                        />
                      )}
                    </td>
                  )}
                  <td className="px-2 py-2 whitespace-nowrap">
                    {date(l.entryDate)} <span className="text-xs text-foreground-subtle">{l.journalCode}</span>
                  </td>
                  <td className="px-2 py-2 font-mono text-xs">{l.pieceRef}</td>
                  <td className="px-2 py-2">{l.label}</td>
                  <td className="tabular px-2 py-2 text-right">{amount(l.debit)}</td>
                  <td className="tabular px-2 py-2 text-right">{amount(l.credit)}</td>
                  <td className="px-5 py-2 text-right">
                    {l.code && (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground">{l.code}</span>
                        {canWrite && firstOfGroup && (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => run(() => unletterAction(l.letteringId!))}
                            className="rounded p-1 text-foreground-subtle hover:bg-muted hover:text-danger"
                            aria-label={`Délettrer ${l.code}`}
                          >
                            <Link2Off className="size-3.5" />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function CloseFiscalYearButton({ fiscalYear, result }: { fiscalYear: number; result: string }) {
  return (
    <ConfirmDialog
      title={`Clôturer l'exercice ${fiscalYear} ?`}
      description={
        <>
          Opération <strong>définitive</strong> : plus aucune écriture ne pourra être enregistrée sur cet exercice. Les soldes des comptes de
          bilan seront repris en à-nouveaux et le résultat ({formatEuro(result)}) porté en attente d&apos;affectation. Faites valider
          les comptes par votre expert-comptable avant de clôturer.
        </>
      }
      confirmLabel="Clôturer définitivement"
      tone="danger"
      onConfirm={async () => {
        const r = await closeFiscalYearAction(fiscalYear);
        if (r.ok) toast.success(r.message);
        else toast.error(r.error);
        return r.ok;
      }}
      trigger={
        <Button variant="danger">
          <Lock className="size-4" aria-hidden /> Clôturer l&apos;exercice {fiscalYear}
        </Button>
      }
    />
  );
}
