"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GraduationCap, Minus, Plus, Receipt, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  closeSessionAction,
  closeTodayAction,
  createRegisterAction,
  openSessionAction,
  recordTicketAction,
  refundTicketAction,
  verifyRegisterAction,
} from "@/app/actions/cash";
import { PAYMENT_METHOD_LABELS, PRODUCT_KIND_LABELS } from "@/lib/schemas";
import { changeDue, computeTicketTotals } from "@/server/domain/cash";
import { D, dec, formatEuro, formatRate } from "@/server/domain/money";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type Method = keyof typeof PAYMENT_METHOD_LABELS;
const POS_METHODS: Method[] = ["cash", "card", "check", "other"];

/** Saisie décimale tolérante (virgule française). */
const norm = (v: string) => v.replace(/\s/g, "").replace(",", ".");
const isNum = (v: string) => /^-?\d+(\.\d+)?$/.test(norm(v));

export function NewRegisterForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [v, setV] = useState({ code: "", name: "" });
  return (
    <Card>
      <CardHeader title="Nouvelle caisse" description="Un numéro court (C1, BAR…) préfixe tous les tickets." />
      <CardBody>
        <form
          method="post"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              setError(null);
              const r = await createRegisterAction({ code: v.code.toUpperCase(), name: v.name });
              if (!r.ok) {
                setError(r.error);
                setFieldErrors(r.fieldErrors ?? {});
                return;
              }
              toast.success(r.message);
              router.push(`/caisse/${r.data!.id}`);
            });
          }}
        >
          {error && <FormAlert>{error}</FormAlert>}
          <Field label="Numéro" htmlFor="cr-code" error={fieldErrors.code} hint="1 à 6 lettres ou chiffres, définitif.">
            <Input id="cr-code" value={v.code} maxLength={6} onChange={(e) => setV((s) => ({ ...s, code: e.target.value.toUpperCase() }))} />
          </Field>
          <Field label="Nom" htmlFor="cr-name" error={fieldErrors.name}>
            <Input id="cr-name" value={v.name} placeholder="Comptoir" onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} />
          </Field>
          <Button type="submit" loading={pending}>
            Créer la caisse
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function OpenSessionForm({ registerId }: { registerId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [float, setFloat] = useState("0");
  return (
    <form
      method="post"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await openSessionAction(registerId, { openingFloat: norm(float) });
          if (!r.ok) return setError(r.error);
          setError(null);
          toast.success(r.message);
        });
      }}
    >
      {error && (
        <div className="w-full">
          <FormAlert>{error}</FormAlert>
        </div>
      )}
      <Field label="Fond de caisse (€)" htmlFor="os-float">
        <Input id="os-float" inputMode="decimal" className="w-40" value={float} onChange={(e) => setFloat(e.target.value)} />
      </Field>
      <Button type="submit" loading={pending}>
        Ouvrir la caisse
      </Button>
    </form>
  );
}

export function CloseSessionForm({ registerId }: { registerId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  return (
    <form
      method="post"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await closeSessionAction(registerId, { countedCash: norm(counted), note: note || undefined });
          if (!r.ok) return setError(r.error);
          toast.success(r.message, { duration: 10000 });
        });
      }}
    >
      {error && <FormAlert>{error}</FormAlert>}
      <Field label="Espèces comptées (€)" htmlFor="cs-counted" hint="Comptez le tiroir avant de consulter le montant attendu.">
        <Input id="cs-counted" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />
      </Field>
      <Field label="Commentaire" htmlFor="cs-note">
        <Input id="cs-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Button type="submit" variant="secondary" loading={pending} disabled={!isNum(counted)}>
        Fermer la session
      </Button>
    </form>
  );
}

export function CloseDayButton({ registerId, disabled }: { registerId: string; disabled: boolean }) {
  return (
    <ConfirmDialog
      title="Clôturer la journée ?"
      description="La clôture est définitive : plus aucun ticket ne pourra être enregistré aujourd'hui sur cette caisse."
      confirmLabel="Clôturer"
      onConfirm={async () => {
        const r = await closeTodayAction(registerId);
        if (r.ok) toast.success(r.message);
        else toast.error(r.error);
        return r.ok;
      }}
      trigger={
        <Button size="sm" variant="secondary" disabled={disabled} title={disabled ? "Fermez d'abord la session" : undefined}>
          Clôturer la journée
        </Button>
      }
    />
  );
}

export function VerifyRegisterButton({ registerId }: { registerId: string }) {
  const [pending, startTransition] = useTransition();
  const [report, setReport] = useState<{ valid: boolean; tickets: number; closures: number; errors: string[] } | null>(null);
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="ghost"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await verifyRegisterAction(registerId);
            if (r.ok) setReport(r.data!);
            else toast.error(r.error);
          })
        }
      >
        <ShieldCheck className="size-3.5" aria-hidden /> Contrôler l&apos;intégrité
      </Button>
      {report && (
        <div role="status" className={`rounded-md px-3 py-2 text-[13px] ${report.valid ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}>
          {report.valid
            ? `Intègre : ${report.tickets} ticket(s) et ${report.closures} clôture(s) vérifiés (chaînage, empreintes, signatures).`
            : report.errors.map((e) => <p key={e}>{e}</p>)}
        </div>
      )}
    </div>
  );
}

// ─── Écran d'encaissement ───────────────────────────────────────────────────

interface CatalogItem {
  id: string;
  reference: string;
  name: string;
  kind: "good" | "service";
  category: string | null;
  barcode: string | null;
  unitPriceInclTax: string;
  vatRate: string;
}

interface CartLine {
  key: string;
  productId: string | null;
  label: string;
  kind: "good" | "service";
  quantity: string;
  unitPriceInclTax: string;
  vatRate: string;
  discountPercent: string;
}

export function PosTerminal({ registerId, catalog, vatRates }: { registerId: string; catalog: CatalogItem[]; vatRates: { label: string; rate: string }[] }) {
  const [pending, startTransition] = useTransition();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [payments, setPayments] = useState<{ method: Method; amount: string }[]>([]);
  const [cashGiven, setCashGiven] = useState("");
  const [training, setTraining] = useState(false);
  const [search, setSearch] = useState("");
  const [free, setFree] = useState({ label: "", price: "", vatRate: vatRates[0]?.rate ?? "20.00", kind: "good" as "good" | "service" });
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ id: string; number: string; total: string; change: string | null } | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const valid = lines.every((l) => isNum(l.quantity) && dec(norm(l.quantity)).greaterThan(0) && isNum(l.unitPriceInclTax) && isNum(l.discountPercent || "0"));
  const totals = useMemo(
    () =>
      valid && lines.length
        ? computeTicketTotals(lines.map((l) => ({ quantity: norm(l.quantity), unitPriceInclTax: norm(l.unitPriceInclTax), vatRate: l.vatRate, discountPercent: norm(l.discountPercent || "0") })))
        : null,
    [lines, valid],
  );
  const total = totals ? dec(totals.totalInclTax) : new D(0);
  const paid = payments.reduce((a, p) => (isNum(p.amount) ? a.plus(norm(p.amount)) : a), new D(0));
  const remaining = total.minus(paid);
  const cashPart = payments.filter((p) => p.method === "cash" && isNum(p.amount)).reduce((a, p) => a.plus(norm(p.amount)), new D(0));
  const change = isNum(cashGiven) && cashPart.greaterThan(0) ? changeDue(norm(cashGiven), cashPart.toFixed(2)) : null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? catalog.filter((p) => p.name.toLowerCase().includes(q) || p.reference.toLowerCase().includes(q) || p.barcode === q) : catalog;
    return list.slice(0, 48);
  }, [catalog, search]);

  const add = (p: CatalogItem) => {
    setLast(null);
    setLines((ls) => {
      const existing = ls.find((l) => l.productId === p.id && l.discountPercent === "0");
      if (existing) return ls.map((l) => (l === existing && isNum(l.quantity) ? { ...l, quantity: dec(norm(l.quantity)).plus(1).toString() } : l));
      return [...ls, { key: crypto.randomUUID(), productId: p.id, label: p.name, kind: p.kind, quantity: "1", unitPriceInclTax: p.unitPriceInclTax, vatRate: p.vatRate, discountPercent: "0" }];
    });
  };
  const update = (key: string, patch: Partial<CartLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const bump = (l: CartLine, delta: number) => {
    if (!isNum(l.quantity)) return;
    const q = dec(norm(l.quantity)).plus(delta);
    if (q.lessThanOrEqualTo(0)) setLines((ls) => ls.filter((x) => x.key !== l.key));
    else update(l.key, { quantity: q.toString() });
  };
  const addPayment = (method: Method) => {
    const amount = remaining.greaterThan(0) ? remaining.toFixed(2) : "";
    setPayments((ps) => {
      const same = ps.find((p) => p.method === method);
      if (same) return ps.map((p) => (p === same ? { ...p, amount: dec(isNum(p.amount) ? norm(p.amount) : "0").plus(amount || "0").toFixed(2) } : p));
      return [...ps, { method, amount }];
    });
  };
  const reset = () => {
    setLines([]);
    setPayments([]);
    setCashGiven("");
    setError(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const r = await recordTicketAction(registerId, {
        idempotencyKey,
        training,
        lines: lines.map((l) => ({ productId: l.productId, label: l.label, kind: l.kind, quantity: norm(l.quantity), unitPriceInclTax: norm(l.unitPriceInclTax), vatRate: l.vatRate, discountPercent: norm(l.discountPercent || "0") })),
        payments: payments.filter((p) => isNum(p.amount) && dec(norm(p.amount)).greaterThan(0)).map((p) => ({ method: p.method, amount: dec(norm(p.amount)).toFixed(2) })),
      });
      if (!r.ok) {
        setError(r.fieldErrors ? `${r.error} ${Object.values(r.fieldErrors).join(" ")}` : r.error);
        return;
      }
      setLast({ ...r.data!, change: change && dec(change).greaterThan(0) ? change : null });
      toast.success(`Ticket ${r.data!.number} enregistré.`);
      reset();
    });

  const canPay = totals !== null && total.greaterThan(0) && remaining.isZero() && payments.length > 0 && !pending;

  return (
    <div className={`grid gap-6 lg:grid-cols-5 ${training ? "rounded-lg outline-2 outline-offset-8 outline-warning outline-dashed" : ""}`}>
      <div className="space-y-4 lg:col-span-3">
        {training && (
          <div className="flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-[13px] font-medium text-warning" role="status">
            <GraduationCap className="size-4" aria-hidden /> MODE ÉCOLE — tickets de formation, sans valeur, exclus des totaux et de la comptabilité.
          </div>
        )}
        <Card>
          <CardHeader
            title="Articles"
            actions={
              <Input
                aria-label="Rechercher un article ou scanner un code-barres"
                placeholder="Rechercher, scanner…"
                className="h-8 w-56"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const q = search.trim().toLowerCase();
                  const exact = catalog.find((p) => p.barcode === search.trim() || p.reference.toLowerCase() === q) ?? (filtered.length === 1 ? filtered[0] : undefined);
                  if (exact) {
                    add(exact);
                    setSearch("");
                  }
                }}
              />
            }
          />
          <CardBody>
            {filtered.length === 0 ? (
              <p className="text-[13px] text-foreground-muted">{catalog.length ? "Aucun article ne correspond." : "Le catalogue est vide : utilisez l'article libre ci-dessous."}</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {filtered.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => add(p)}
                    className="flex min-h-16 flex-col items-start justify-between rounded-md border border-border bg-background px-3 py-2 text-left hover:border-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span className="line-clamp-2 text-[13px] font-medium">{p.name}</span>
                    <span className="tabular text-xs text-foreground-muted">{formatEuro(p.unitPriceInclTax)}</span>
                  </button>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Article libre" />
          <CardBody>
            <form
              method="post"
              className="grid gap-3 sm:grid-cols-[1fr_7rem_8rem_8rem_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                if (!free.label.trim() || !isNum(free.price)) return;
                setLast(null);
                setLines((ls) => [...ls, { key: crypto.randomUUID(), productId: null, label: free.label.trim(), kind: free.kind, quantity: "1", unitPriceInclTax: norm(free.price), vatRate: free.vatRate, discountPercent: "0" }]);
                setFree((f) => ({ ...f, label: "", price: "" }));
              }}
            >
              <Input aria-label="Libellé" placeholder="Libellé" value={free.label} onChange={(e) => setFree((f) => ({ ...f, label: e.target.value }))} />
              <Input aria-label="Prix TTC" placeholder="Prix TTC" inputMode="decimal" value={free.price} onChange={(e) => setFree((f) => ({ ...f, price: e.target.value }))} />
              <Select aria-label="Taux de TVA" value={free.vatRate} onChange={(e) => setFree((f) => ({ ...f, vatRate: e.target.value }))}>
                {vatRates.map((r) => (
                  <option key={r.rate} value={r.rate}>
                    TVA {formatRate(r.rate)}
                  </option>
                ))}
              </Select>
              <Select aria-label="Nature" value={free.kind} onChange={(e) => setFree((f) => ({ ...f, kind: e.target.value as "good" | "service" }))}>
                <option value="good">{PRODUCT_KIND_LABELS.good}</option>
                <option value="service">{PRODUCT_KIND_LABELS.service}</option>
              </Select>
              <Button type="submit" variant="secondary" disabled={!free.label.trim() || !isNum(free.price)}>
                <Plus className="size-3.5" aria-hidden /> Ajouter
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>

      <Card className="lg:col-span-2">
        <CardHeader
          title="Ticket en cours"
          actions={<Checkbox label="Mode école" checked={training} onChange={(e) => setTraining(e.target.checked)} />}
        />
        <CardBody className="space-y-4">
          {last && (
            <div className="rounded-md bg-success-soft px-3 py-2 text-[13px] text-success" role="status">
              Ticket {last.number} enregistré ({formatEuro(last.total)}).
              {last.change && <strong> Rendu monnaie : {formatEuro(last.change)}.</strong>}{" "}
              <Link href={`/caisse/tickets/${last.id}`} className="font-medium underline">
                Voir / imprimer
              </Link>
            </div>
          )}
          {error && <FormAlert>{error}</FormAlert>}
          {lines.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-foreground-muted">Ajoutez des articles pour commencer.</p>
          ) : (
            <ul className="divide-y divide-border">
              {lines.map((l, i) => (
                <li key={l.key} className="space-y-1.5 py-2">
                  <div className="flex items-start gap-2">
                    <span className="flex-1 text-[13px] font-medium">{l.label}</span>
                    <span className="tabular text-[13px] font-semibold">{totals ? formatEuro(totals.lineTotals[i]!) : "—"}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-foreground-muted">
                    <button type="button" className="rounded border border-border p-1 hover:bg-muted" aria-label={`Retirer un ${l.label}`} onClick={() => bump(l, -1)}>
                      <Minus className="size-3" />
                    </button>
                    <Input aria-label={`Quantité ${l.label}`} className="h-7 w-16 text-center text-xs" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                    <button type="button" className="rounded border border-border p-1 hover:bg-muted" aria-label={`Ajouter un ${l.label}`} onClick={() => bump(l, 1)}>
                      <Plus className="size-3" />
                    </button>
                    <span>× {isNum(l.unitPriceInclTax) ? formatEuro(norm(l.unitPriceInclTax)) : "?"}</span>
                    <span className="ml-auto flex items-center gap-1">
                      Remise
                      <Input aria-label={`Remise % ${l.label}`} className="h-7 w-14 text-center text-xs" value={l.discountPercent} onChange={(e) => update(l.key, { discountPercent: e.target.value })} />%
                    </span>
                    <button type="button" className="rounded p-1 hover:bg-muted hover:text-danger" aria-label={`Supprimer ${l.label}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-border pt-3">
            {totals && (
              <div className="mb-2 space-y-0.5 text-xs text-foreground-muted">
                {totals.vat.map((v) => (
                  <p key={v.vatRate} className="flex justify-between">
                    <span>TVA {formatRate(v.vatRate)} sur {formatEuro(v.exclTax)} HT</span>
                    <span className="tabular">{formatEuro(v.vat)}</span>
                  </p>
                ))}
              </div>
            )}
            <p className="flex items-baseline justify-between">
              <span className="text-sm font-medium">Total TTC</span>
              <span className="tabular text-2xl font-semibold">{formatEuro(total)}</span>
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {POS_METHODS.map((m) => (
                <Button key={m} size="sm" variant="secondary" disabled={!totals || remaining.lessThanOrEqualTo(0)} onClick={() => addPayment(m)}>
                  {PAYMENT_METHOD_LABELS[m]}
                </Button>
              ))}
            </div>
            {payments.map((p, i) => (
              <div key={p.method} className="flex items-center gap-2 text-[13px]">
                <span className="w-28">{PAYMENT_METHOD_LABELS[p.method]}</span>
                <Input
                  aria-label={`Montant ${PAYMENT_METHOD_LABELS[p.method]}`}
                  inputMode="decimal"
                  className="h-8 flex-1"
                  value={p.amount}
                  onChange={(e) => setPayments((ps) => ps.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                />
                <button type="button" className="rounded p-1 text-foreground-subtle hover:bg-muted hover:text-danger" aria-label={`Retirer ${PAYMENT_METHOD_LABELS[p.method]}`} onClick={() => setPayments((ps) => ps.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            {cashPart.greaterThan(0) && (
              <div className="flex items-center gap-2 text-[13px]">
                <span className="w-28">Espèces remises</span>
                <Input aria-label="Espèces remises par le client" inputMode="decimal" className="h-8 flex-1" value={cashGiven} onChange={(e) => setCashGiven(e.target.value)} />
                {change && <span className="tabular text-xs font-medium">Rendu {formatEuro(change)}</span>}
              </div>
            )}
            {totals && !remaining.isZero() && payments.length > 0 && (
              <p className="text-xs text-warning">{remaining.isNegative() ? `Trop perçu : ${formatEuro(remaining.negated())}` : `Reste à payer : ${formatEuro(remaining)}`}</p>
            )}
          </div>

          <div className="flex gap-2">
            <Button className="flex-1" disabled={!canPay} loading={pending} onClick={submit}>
              <Receipt className="size-4" aria-hidden /> Encaisser {totals ? formatEuro(total) : ""}
            </Button>
            <Button variant="ghost" disabled={pending || (!lines.length && !payments.length)} onClick={reset}>
              Annuler
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

// ─── Remboursement ──────────────────────────────────────────────────────────

export function RefundForm({
  ticketId,
  lines,
}: {
  ticketId: string;
  lines: { position: number; label: string; quantity: string; remaining: string; remainingAmount: string; totalInclTax: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<number, string>>(() => Object.fromEntries(lines.map((l) => [l.position, l.remaining])));
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const selected = lines.filter((l) => isNum(qty[l.position] ?? "") && dec(norm(qty[l.position]!)).greaterThan(0));
  // Estimation affichée ; le serveur calcule le montant exact (prorata du total encaissé).
  const estimate = selected.reduce((a, l) => {
    const q = dec(norm(qty[l.position]!));
    return a.plus(q.equals(l.remaining) ? l.remainingAmount : dec(l.totalInclTax).times(q).dividedBy(l.quantity).toDecimalPlaces(2, D.ROUND_HALF_UP));
  }, new D(0));

  return (
    <form
      method="post"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await refundTicketAction(ticketId, {
            idempotencyKey,
            reason,
            lines: selected.map((l) => ({ position: l.position, quantity: norm(qty[l.position]!) })),
            payments: [{ method, amount: estimate.toFixed(2) }],
          });
          if (!r.ok) return setError(r.error);
          toast.success(r.message);
          router.push(`/caisse/tickets/${r.data!.id}`);
        });
      }}
    >
      {error && <FormAlert>{error}</FormAlert>}
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-xs text-foreground-muted">
            <th className="py-1 font-medium">Article</th>
            <th className="py-1 text-right font-medium">Remboursable</th>
            <th className="py-1 text-right font-medium">Quantité</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.position} className="border-t border-border">
              <td className="py-1.5">{l.label}</td>
              <td className="tabular py-1.5 text-right">{dec(l.remaining).toString().replace(".", ",")}</td>
              <td className="py-1.5 text-right">
                <Input
                  aria-label={`Quantité remboursée ${l.label}`}
                  className="ml-auto h-7 w-20 text-right text-xs"
                  disabled={dec(l.remaining).isZero()}
                  value={qty[l.position] ?? ""}
                  onChange={(e) => setQty((s) => ({ ...s, [l.position]: e.target.value }))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Motif" htmlFor="rf-reason" required>
          <Input id="rf-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Retour article, erreur de saisie…" />
        </Field>
        <Field label="Remboursé en" htmlFor="rf-method">
          <Select id="rf-method" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
            {POS_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button type="submit" variant="danger" loading={pending} disabled={!selected.length || reason.trim().length < 3}>
        Rembourser {formatEuro(estimate)}
      </Button>
    </form>
  );
}
