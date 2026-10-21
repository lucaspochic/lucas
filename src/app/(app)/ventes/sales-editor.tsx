"use client";

import { useMemo, useState, useTransition } from "react";
import { useFieldArray, useForm, useWatch, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PRODUCT_KIND_LABELS, PRODUCT_KINDS, salesDraftSchema, UNITS, type SalesDraftInput } from "@/lib/schemas";
import { createSalesDraftAction, updateSalesDraftAction } from "@/app/actions/sales";
import { computeDocumentTotals, type DocumentTotals } from "@/server/domain/document-totals";
import { formatEuro, formatRate } from "@/server/domain/money";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

export interface CustomerOption {
  id: string;
  code: string;
  name: string;
}
export interface ProductOption {
  id: string;
  reference: string;
  name: string;
  description: string | null;
  kind: "good" | "service";
  unit: string;
  unitPriceExclTax: string;
  vatRateId: string;
}
export interface RateOption {
  id: string;
  label: string;
  rate: string;
  exemptionReason: string | null;
  active: boolean;
}

const normalize = (v: string | undefined) => (v ?? "").replace(/[\s  €%]/g, "").replace(",", ".");
const editable = (v: string) => {
  const [i, f = ""] = v.split(".");
  const t = f.replace(/0+$/, "");
  return t ? `${i},${t}` : i!;
};

/**
 * Éditeur de brouillon. Les totaux affichés sont un APERÇU calculé avec la même fonction que
 * le serveur ; le serveur recalcule tout à l'enregistrement et à l'émission.
 */
export function SalesEditor({
  documentId,
  type,
  defaults,
  customers,
  productOptions,
  rates,
  customerLocked = false,
  fixedLines = [],
}: {
  documentId?: string;
  type: "quote" | "invoice" | "credit_note";
  defaults: SalesDraftInput;
  customers: CustomerOption[];
  productOptions: ProductOption[];
  rates: RateOption[];
  customerLocked?: boolean;
  /** Lignes calculées par le serveur (déductions d'acomptes), reprises dans l'aperçu des totaux. */
  fixedLines?: { quantity: string; unitPriceExclTax: string; vatRate: string; vatExemptionReason: string | null }[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<SalesDraftInput>({ resolver: zodResolver(salesDraftSchema), defaultValues: defaults, mode: "onTouched" });
  const { register, handleSubmit, control, formState, setValue, setError: setFieldError } = form;
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const lines = useWatch({ control, name: "lines" });
  const globalDiscount = useWatch({ control, name: "globalDiscountPercent" });

  const preview: DocumentTotals | null = useMemo(() => {
    try {
      return computeDocumentTotals({
        lines: (lines ?? []).map((l) => {
          const rate = rates.find((r) => r.id === l.vatRateId);
          return {
            quantity: normalize(l.quantity) || "0",
            unitPriceExclTax: normalize(l.unitPriceExclTax) || "0",
            discountPercent: normalize(l.discountPercent) || "0",
            vatRate: rate?.rate ?? "0",
            vatExemptionReason: rate?.exemptionReason ?? (rate ? undefined : "—"),
          };
        }).concat(fixedLines.map((l) => ({ ...l, vatExemptionReason: l.vatExemptionReason ?? undefined, discountPercent: "0", noGlobalDiscount: true }))),
        globalDiscountPercent: normalize(globalDiscount) || "0",
      });
    } catch {
      return null;
    }
  }, [lines, globalDiscount, rates, fixedLines]);

  const activeRates = rates.filter((r) => r.active || (lines ?? []).some((l) => l.vatRateId === r.id));
  const defaultRate = rates.find((r) => r.active)?.id ?? "";
  const errors = formState.errors;
  const lineError = (i: number, f: string) =>
    (errors.lines?.[i] as Record<string, { message?: string } | undefined> | undefined)?.[f]?.message;

  const pickProduct = (index: number, productId: string) => {
    const p = productOptions.find((x) => x.id === productId);
    setValue(`lines.${index}.productId`, p ? p.id : null, { shouldDirty: true });
    if (!p) return;
    const opts = { shouldDirty: true, shouldValidate: true };
    setValue(`lines.${index}.reference`, p.reference, opts);
    setValue(`lines.${index}.description`, p.description ? `${p.name}\n${p.description}` : p.name, opts);
    setValue(`lines.${index}.kind`, p.kind, opts);
    setValue(`lines.${index}.unit`, (UNITS.find((u) => u === p.unit) ?? "unité") as (typeof UNITS)[number], opts);
    setValue(`lines.${index}.unitPriceExclTax`, editable(p.unitPriceExclTax), opts);
    setValue(`lines.${index}.vatRateId`, p.vatRateId, opts);
  };

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      setError(null);
      const result = documentId
        ? await updateSalesDraftAction(documentId, values)
        : await createSalesDraftAction(type === "quote" ? "quote" : "invoice", values);
      if (result?.ok) {
        toast.success(result.message ?? "Enregistré.");
        form.reset(values);
      } else if (result) {
        setError(result.error);
        for (const [f, message] of Object.entries(result.fieldErrors ?? {})) setFieldError(f as FieldPath<SalesDraftInput>, { message });
      }
    }),
  );

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="space-y-6">
      {error && <FormAlert>{error}</FormAlert>}
      <fieldset disabled={pending} className="space-y-6">
        <Card>
          <CardHeader title="Client et dates" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Client" htmlFor="thirdPartyId" error={errors.thirdPartyId?.message} required>
              {customerLocked ? (
                // Un champ désactivé n'est pas transmis : on affiche le client et on conserve la valeur.
                <>
                  <input type="hidden" {...register("thirdPartyId")} />
                  <p id="thirdPartyId" className="flex h-9 items-center text-sm">
                    {customers.find((c) => c.id === defaults.thirdPartyId)?.name ?? "Client de la facture d'origine"}
                  </p>
                </>
              ) : (
                <Select id="thirdPartyId" aria-invalid={!!errors.thirdPartyId} {...register("thirdPartyId")}>
                  <option value="">— Choisir un client —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Date de livraison ou d'exécution"
              htmlFor="deliveryDate"
              error={errors.deliveryDate?.message}
              hint="Si différente de la date d'émission (fixée au jour de l'émission)."
            >
              <Input id="deliveryDate" type="date" {...register("deliveryDate")} />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Lignes"
            description={errors.lines?.message ?? errors.lines?.root?.message}
            actions={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  append({ productId: null, description: "", kind: "service", quantity: "1", unit: "unité", unitPriceExclTax: "", discountPercent: "0", vatRateId: defaultRate })
                }
              >
                <Plus className="size-4" aria-hidden /> Ligne
              </Button>
            }
          />
          <div className="divide-y divide-border">
            {fields.map((field, i) => {
              const total = preview?.lines[i]?.totalExclTaxBeforeGlobalDiscount;
              return (
                <div key={field.id} className="grid gap-3 px-5 py-4 lg:grid-cols-12">
                  <div className="space-y-2 lg:col-span-5">
                    {productOptions.length > 0 && (
                      <Select
                        aria-label={`Article du catalogue, ligne ${i + 1}`}
                        className="h-8 text-[13px]"
                        value={lines?.[i]?.productId ?? ""}
                        onChange={(e) => pickProduct(i, e.target.value)}
                      >
                        <option value="">Saisie libre</option>
                        {productOptions.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.reference} — {p.name}
                          </option>
                        ))}
                      </Select>
                    )}
                    <Textarea
                      aria-label={`Désignation, ligne ${i + 1}`}
                      placeholder="Désignation"
                      rows={2}
                      aria-invalid={!!lineError(i, "description")}
                      {...register(`lines.${i}.description`)}
                    />
                    {lineError(i, "description") && <p className="text-xs text-danger">{lineError(i, "description")}</p>}
                    <Select aria-label={`Nature, ligne ${i + 1}`} className="h-8 text-[13px]" {...register(`lines.${i}.kind`)}>
                      {PRODUCT_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {PRODUCT_KIND_LABELS[k]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1.2fr_1.2fr_1fr] lg:col-span-6">
                    <Field label="Quantité" htmlFor={`q-${i}`} error={lineError(i, "quantity")}>
                      <Input id={`q-${i}`} inputMode="decimal" {...register(`lines.${i}.quantity`)} />
                    </Field>
                    <Field label="Unité" htmlFor={`u-${i}`}>
                      <Select id={`u-${i}`} {...register(`lines.${i}.unit`)}>
                        {UNITS.map((u) => (
                          <option key={u} value={u}>
                            {u}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="PU HT (€)" htmlFor={`p-${i}`} error={lineError(i, "unitPriceExclTax")}>
                      <Input id={`p-${i}`} inputMode="decimal" {...register(`lines.${i}.unitPriceExclTax`)} />
                    </Field>
                    <Field label="Remise %" htmlFor={`d-${i}`} error={lineError(i, "discountPercent")}>
                      <Input id={`d-${i}`} inputMode="decimal" {...register(`lines.${i}.discountPercent`)} />
                    </Field>
                    <Field label="TVA" htmlFor={`t-${i}`} error={lineError(i, "vatRateId")} className="col-span-2">
                      <Select id={`t-${i}`} {...register(`lines.${i}.vatRateId`)}>
                        {activeRates.map((r) => (
                          <option key={r.id} value={r.id}>
                            {formatRate(r.rate)}
                            {r.exemptionReason ? ` — ${r.exemptionReason}` : ""}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <div className="col-span-2 flex flex-col justify-end text-right">
                      <span className="text-xs text-foreground-muted">Total HT</span>
                      <span className="tabular text-sm font-semibold">{total ? formatEuro(total) : "—"}</span>
                    </div>
                  </div>
                  <div className="flex items-start justify-end lg:col-span-1">
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      disabled={fields.length === 1}
                      className="rounded p-1.5 text-foreground-subtle hover:bg-muted hover:text-danger disabled:opacity-30"
                      aria-label={`Supprimer la ligne ${i + 1}`}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Conditions" />
            <CardBody className="space-y-4">
              <Field label="Remise globale (%)" htmlFor="globalDiscountPercent" error={errors.globalDiscountPercent?.message}>
                <Input id="globalDiscountPercent" inputMode="decimal" className="w-32" {...register("globalDiscountPercent")} />
              </Field>
              <Field label="Notes" htmlFor="notes" hint="Imprimées sur le document.">
                <Textarea id="notes" rows={3} {...register("notes")} />
              </Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Totaux (aperçu)" description="Recalculés par le serveur à l'enregistrement et à l'émission." />
            <CardBody>
              {preview ? (
                <dl className="space-y-1.5 text-[13px]">
                  {preview.vatBreakdown.map((v) => (
                    <div key={`${v.vatRate}-${v.vatExemptionReason}`} className="flex justify-between text-foreground-muted">
                      <dt>
                        Base {formatRate(v.vatRate)} : {formatEuro(v.baseExclTax)}
                      </dt>
                      <dd className="tabular">TVA {formatEuro(v.vatAmount)}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between border-t border-border pt-2">
                    <dt>Total HT</dt>
                    <dd className="tabular">{formatEuro(preview.totalExclTax)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Total TVA</dt>
                    <dd className="tabular">{formatEuro(preview.totalVat)}</dd>
                  </div>
                  <div className="flex justify-between text-base font-semibold">
                    <dt>Total TTC</dt>
                    <dd className="tabular">{formatEuro(preview.totalInclTax)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-[13px] text-foreground-muted">Complétez les lignes pour voir les totaux.</p>
              )}
            </CardBody>
          </Card>
        </div>
      </fieldset>

      <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
        <Button type="submit" loading={pending} disabled={!!documentId && !formState.isDirty}>
          {documentId ? "Enregistrer le brouillon" : "Créer le brouillon"}
        </Button>
      </div>
    </form>
  );
}
