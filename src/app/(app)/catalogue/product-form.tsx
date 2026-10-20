"use client";

import { useState, useTransition } from "react";
import { useForm, useWatch, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { PRODUCT_KIND_LABELS, PRODUCT_KINDS, productSchema, UNITS, type ProductInput } from "@/lib/schemas";
import { createProductAction, updateProductAction } from "@/app/actions/products";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

interface RateOption {
  id: string;
  label: string;
  rate: string;
  exemptionReason: string | null;
}

/**
 * Aperçu indicatif du TTC (affichage uniquement, en centimes entiers pour éviter les flottants).
 * Le serveur recalcule toujours les montants.
 */
function previewInclTax(priceText: string | undefined, rate: string | undefined): string | null {
  const p = (priceText ?? "").replace(/[\s€]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,4})?$/.test(p) || !rate) return null;
  const [int, frac = ""] = p.split(".");
  const tenThousandths = BigInt(int!) * 10000n + BigInt((frac + "0000").slice(0, 4));
  const [ri, rf = ""] = rate.split(".");
  const rateHundredths = BigInt(ri!) * 100n + BigInt((rf + "00").slice(0, 2));
  // prix × (10000 + taux×100) / 10000, en 1/10000 de centime → arrondi au centime (demi supérieur).
  const scaled = tenThousandths * (10000n + rateHundredths);
  const cents = (scaled + 5000n * 100n) / (10000n * 100n);
  const euros = cents / 100n;
  const rest = String(cents % 100n).padStart(2, "0");
  return `${euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${rest} €`;
}

export function ProductForm({
  id,
  defaults,
  rates,
  readOnly = false,
}: {
  id?: string;
  defaults: ProductInput;
  rates: RateOption[];
  readOnly?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<ProductInput>({ resolver: zodResolver(productSchema), defaultValues: defaults, mode: "onTouched" });
  const { register, handleSubmit, formState, control, setError: setFieldError } = form;
  const price = useWatch({ control, name: "unitPriceExclTax" });
  const vatRateId = useWatch({ control, name: "vatRateId" });
  const errors = formState.errors as Record<string, { message?: string } | undefined>;
  const err = (n: string) => errors[n]?.message;
  const ttc = previewInclTax(price, rates.find((r) => r.id === vatRateId)?.rate);

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      setError(null);
      const result = id ? await updateProductAction(id, values) : await createProductAction(values);
      if (result?.ok) {
        toast.success(result.message ?? "Enregistré.");
        form.reset(values);
      } else if (result) {
        setError(result.error);
        for (const [f, message] of Object.entries(result.fieldErrors ?? {})) setFieldError(f as FieldPath<ProductInput>, { message });
      }
    }),
  );

  const text = (name: FieldPath<ProductInput>, label: string, extra: { hint?: string; required?: boolean; inputMode?: "numeric" | "decimal"; placeholder?: string } = {}) => (
    <Field label={label} htmlFor={name} error={err(name)} hint={extra.hint} required={extra.required}>
      <Input
        id={name}
        inputMode={extra.inputMode}
        placeholder={extra.placeholder}
        aria-invalid={!!err(name)}
        defaultValue={String(defaults[name as keyof ProductInput] ?? "")}
        {...register(name)}
      />
    </Field>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {error && <FormAlert>{error}</FormAlert>}
      <fieldset disabled={readOnly || pending} className="space-y-6">
        <Card>
          <CardHeader title="Article" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {text("reference", "Référence", { required: true, hint: "Unique dans le catalogue." })}
            <Field label="Nature" htmlFor="kind" error={err("kind")} required hint="Catégorie d'opération exigée par la facturation électronique.">
              <Select id="kind" {...register("kind")}>
                {PRODUCT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PRODUCT_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="sm:col-span-2">{text("name", "Désignation", { required: true })}</div>
            <Field label="Description" htmlFor="description" error={err("description")} className="sm:col-span-2" hint="Reprise sur les devis et factures.">
              <Textarea id="description" rows={3} defaultValue={String(defaults.description ?? "")} {...register("description")} />
            </Field>
            {text("category", "Catégorie")}
            {text("barcode", "Code-barres (EAN)", { inputMode: "numeric" })}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Prix" description="Les montants des documents sont toujours recalculés par le serveur." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {text("unitPriceExclTax", "Prix de vente HT (€)", { required: true, inputMode: "decimal", placeholder: "0,00" })}
            <Field label="Unité" htmlFor="unit" error={err("unit")} required>
              <Select id="unit" {...register("unit")}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Taux de TVA" htmlFor="vatRateId" error={err("vatRateId")} required>
              <Select id="vatRateId" {...register("vatRateId")}>
                {rates.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                    {r.exemptionReason ? ` — ${r.exemptionReason}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="space-y-1.5">
              <span className="block text-[13px] font-medium">Prix de vente TTC (indicatif)</span>
              <p className="tabular flex h-9 items-center text-sm font-semibold">{ttc ?? "—"}</p>
            </div>
            {text("purchasePriceExclTax", "Prix d'achat HT (€)", { inputMode: "decimal", hint: "Facultatif, pour le calcul de marge." })}
          </CardBody>
        </Card>
      </fieldset>

      {!readOnly && (
        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
          {id && (
            <Button type="button" variant="secondary" disabled={!formState.isDirty || pending} onClick={() => form.reset(defaults)}>
              Annuler
            </Button>
          )}
          <Button type="submit" loading={pending} disabled={!!id && !formState.isDirty}>
            {id ? "Enregistrer" : "Créer l'article"}
          </Button>
        </div>
      )}
    </form>
  );
}
