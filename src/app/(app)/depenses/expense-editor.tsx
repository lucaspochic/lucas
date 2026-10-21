"use client";

import { useMemo, useState, useTransition } from "react";
import { useFieldArray, useForm, useWatch, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_KEYS, expenseSchema, FRENCH_VAT_RATES, type ExpenseInput } from "@/lib/schemas";
import { createExpenseAction, updateExpenseAction } from "@/app/actions/purchases";
import { D, dec, formatEuro, roundMoney } from "@/server/domain/money";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

const norm = (v: string | null | undefined) => (v ?? "").replace(/[\s  €]/g, "").replace(",", ".");
const safe = (v: string | null | undefined) => (/^\d+(\.\d{1,2})?$/.test(norm(v)) ? dec(norm(v)) : null);

export function ExpenseEditor({
  expenseId,
  defaults,
  suppliers,
}: {
  expenseId?: string;
  defaults: ExpenseInput;
  suppliers: { id: string; label: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<ExpenseInput>({ resolver: zodResolver(expenseSchema), defaultValues: defaults, mode: "onTouched" });
  const { register, control, handleSubmit, formState, setError: setFieldError } = form;
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const lines = useWatch({ control, name: "lines" });

  const preview = useMemo(() => {
    const rows = (lines ?? []).map((l) => {
      const amount = safe(l.amountExclTax);
      const computed = amount ? roundMoney(amount.times(dec(l.vatRate || "0")).dividedBy(100)) : null;
      return { amount, computed, used: safe(l.vatAmount ?? "") ?? computed };
    });
    const ht = rows.reduce((acc, r) => (r.amount ? acc.plus(r.amount) : acc), new D(0));
    const vat = rows.reduce((acc, r) => (r.used ? acc.plus(r.used) : acc), new D(0));
    return { ht, vat, ttc: ht.plus(vat), perLine: rows.map((r) => r.computed) };
  }, [lines]);

  const errors = formState.errors;
  const lineError = (i: number, f: string) =>
    (errors.lines?.[i] as Record<string, { message?: string } | undefined> | undefined)?.[f]?.message;

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      setError(null);
      const result = expenseId ? await updateExpenseAction(expenseId, values) : await createExpenseAction(values);
      if (result?.ok) {
        toast.success(result.message ?? "Enregistré.");
        form.reset(values);
      } else if (result) {
        setError(result.error);
        for (const [f, message] of Object.entries(result.fieldErrors ?? {})) setFieldError(f as FieldPath<ExpenseInput>, { message });
      }
    }),
  );

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="space-y-6">
      {error && <FormAlert>{error}</FormAlert>}
      <fieldset disabled={pending} className="space-y-6">
        <Card>
          <CardHeader title="Facture du fournisseur" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Fournisseur" htmlFor="thirdPartyId" error={errors.thirdPartyId?.message} required>
              <Select id="thirdPartyId" defaultValue={defaults.thirdPartyId} {...register("thirdPartyId")}>
                <option value="">— Choisir un fournisseur —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="N° de facture du fournisseur" htmlFor="supplierReference">
              <Input id="supplierReference" defaultValue={defaults.supplierReference ?? ""} {...register("supplierReference")} />
            </Field>
            <Field label="Date de la facture" htmlFor="invoiceDate" error={errors.invoiceDate?.message} required>
              <Input id="invoiceDate" type="date" defaultValue={defaults.invoiceDate} {...register("invoiceDate")} />
            </Field>
            <Field label="Échéance" htmlFor="dueDate" hint="Vide : 30 jours après la date de facture.">
              <Input id="dueDate" type="date" defaultValue={defaults.dueDate ?? ""} {...register("dueDate")} />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Lignes"
            description={errors.lines?.message ?? "Une ligne par catégorie de charge et par taux de TVA."}
            actions={
              <Button type="button" size="sm" variant="secondary" onClick={() => append({ category: "autre", description: "", amountExclTax: "", vatRate: "20", vatAmount: "" })}>
                <Plus className="size-4" aria-hidden /> Ligne
              </Button>
            }
          />
          <div className="divide-y divide-border">
            {fields.map((field, i) => (
              <div key={field.id} className="grid gap-3 px-5 py-4 sm:grid-cols-12">
                <Field label="Catégorie" htmlFor={`c-${i}`} className="sm:col-span-3">
                  <Select id={`c-${i}`} {...register(`lines.${i}.category`)}>
                    {EXPENSE_CATEGORY_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {EXPENSE_CATEGORIES[k].label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Libellé" htmlFor={`l-${i}`} error={lineError(i, "description")} className="sm:col-span-3">
                  <Input id={`l-${i}`} {...register(`lines.${i}.description`)} />
                </Field>
                <Field label="Montant HT" htmlFor={`a-${i}`} error={lineError(i, "amountExclTax")} className="sm:col-span-2">
                  <Input id={`a-${i}`} inputMode="decimal" {...register(`lines.${i}.amountExclTax`)} />
                </Field>
                <Field label="TVA" htmlFor={`r-${i}`} className="sm:col-span-1">
                  <Select id={`r-${i}`} {...register(`lines.${i}.vatRate`)}>
                    {FRENCH_VAT_RATES.map((r) => (
                      <option key={r} value={r}>
                        {r.replace(".", ",")} %
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Montant TVA"
                  htmlFor={`v-${i}`}
                  error={lineError(i, "vatAmount")}
                  className="sm:col-span-2"
                  hint={preview.perLine[i] ? `Calculée : ${formatEuro(preview.perLine[i]!)}` : undefined}
                >
                  <Input id={`v-${i}`} inputMode="decimal" placeholder="Auto" {...register(`lines.${i}.vatAmount`)} />
                </Field>
                <div className="flex items-end justify-end pb-1 sm:col-span-1">
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
            ))}
          </div>
          <CardBody className="flex flex-wrap justify-end gap-6 border-t border-border text-[13px]">
            <span>
              HT <span className="tabular font-medium">{formatEuro(preview.ht)}</span>
            </span>
            <span>
              TVA <span className="tabular font-medium">{formatEuro(preview.vat)}</span>
            </span>
            <span className="text-sm font-semibold">
              TTC <span className="tabular">{formatEuro(preview.ttc)}</span>
            </span>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Field label="Notes" htmlFor="notes">
              <Textarea id="notes" rows={2} defaultValue={defaults.notes ?? ""} {...register("notes")} />
            </Field>
          </CardBody>
        </Card>
      </fieldset>
      <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
        <Button type="submit" loading={pending} disabled={!!expenseId && !formState.isDirty}>
          {expenseId ? "Enregistrer le brouillon" : "Créer le brouillon"}
        </Button>
      </div>
    </form>
  );
}
