"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useForm, useWatch, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_CATEGORY_LABELS,
  equipmentSchema,
  METER_UNIT_LABELS,
  METER_UNITS,
  type EquipmentInput,
} from "@/lib/schemas";
import { createEquipmentAction, invoicesOfPartyAction, updateEquipmentAction, type InvoiceOption } from "@/app/actions/equipment";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

const frDate = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "");

/** Libellés adaptés à la catégorie : un véhicule a un VIN et des kilomètres, un tracteur des heures. */
const SERIAL_LABEL: Record<string, { label: string; hint: string }> = {
  vehicle: { label: "Numéro VIN", hint: "17 caractères, repère E de la carte grise." },
  agricultural: { label: "Numéro de série", hint: "Plaque constructeur ou carte grise (repère E)." },
  construction: { label: "Numéro de série", hint: "Plaque constructeur." },
  other: { label: "Numéro de série", hint: "Unique dans le parc." },
};

export function EquipmentForm({
  id,
  defaults,
  customers,
  initialInvoices,
  readOnly = false,
}: {
  id?: string;
  defaults: EquipmentInput;
  customers: { id: string; code: string; name: string }[];
  initialInvoices: InvoiceOption[];
  readOnly?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState(initialInvoices);
  const form = useForm<EquipmentInput>({ resolver: zodResolver(equipmentSchema), defaultValues: defaults, mode: "onTouched" });
  const { register, handleSubmit, formState, control, setValue, setError: setFieldError } = form;
  const errors = formState.errors as Record<string, { message?: string } | undefined>;
  const err = (n: string) => errors[n]?.message;
  const category = useWatch({ control, name: "category" });
  const thirdPartyId = useWatch({ control, name: "thirdPartyId" });
  const serial = SERIAL_LABEL[String(category)] ?? SERIAL_LABEL.other!;

  // Factures proposées : celles du client choisi, rechargées quand il change.
  const loadedFor = useRef(defaults.thirdPartyId);
  useEffect(() => {
    if (!thirdPartyId || thirdPartyId === loadedFor.current) return;
    loadedFor.current = thirdPartyId;
    setValue("salesDocumentId", "");
    void invoicesOfPartyAction(String(thirdPartyId)).then((r) => setInvoices(r.ok ? (r.data ?? []) : []));
  }, [thirdPartyId, setValue]);

  // Unité de compteur par défaut selon la catégorie (modifiable).
  const onCategoryChange = (value: string) => {
    if (!form.getValues("meterValue")) setValue("meterUnit", value === "vehicle" ? "km" : value === "other" ? "" : "h");
  };

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      setError(null);
      const result = id ? await updateEquipmentAction(id, values) : await createEquipmentAction(values);
      if (result?.ok) {
        toast.success(result.message ?? "Enregistré.");
        form.reset(values);
      } else if (result) {
        setError(result.error);
        for (const [f, message] of Object.entries(result.fieldErrors ?? {})) setFieldError(f as FieldPath<EquipmentInput>, { message });
      }
    }),
  );

  const text = (
    name: FieldPath<EquipmentInput>,
    label: string,
    extra: { hint?: string; required?: boolean; inputMode?: "numeric"; placeholder?: string; type?: string; className?: string } = {},
  ) => (
    <Field label={label} htmlFor={name} error={err(name)} hint={extra.hint} required={extra.required} className={extra.className}>
      <Input
        id={name}
        type={extra.type}
        inputMode={extra.inputMode}
        placeholder={extra.placeholder}
        aria-invalid={!!err(name)}
        defaultValue={String(defaults[name as keyof EquipmentInput] ?? "")}
        {...register(name)}
      />
    </Field>
  );

  const categoryField = register("category");

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="space-y-6">
      {error && <FormAlert>{error}</FormAlert>}
      <fieldset disabled={readOnly || pending} className="space-y-6">
        <Card>
          <CardHeader title="Matériel" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Client propriétaire" htmlFor="thirdPartyId" error={err("thirdPartyId")} required hint={id ? "Changer de client trace une revente ou une reprise." : undefined}>
              <Select id="thirdPartyId" aria-invalid={!!err("thirdPartyId")} defaultValue={String(defaults.thirdPartyId ?? "")} {...register("thirdPartyId")}>
                <option value="">— Choisir —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Catégorie" htmlFor="category" error={err("category")} required>
              <Select
                id="category"
                defaultValue={String(defaults.category ?? "")}
                {...categoryField}
                onChange={(e) => {
                  void categoryField.onChange(e);
                  onCategoryChange(e.target.value);
                }}
              >
                {EQUIPMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {EQUIPMENT_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
            {text("brand", "Marque", { required: true, placeholder: category === "agricultural" ? "ex. John Deere" : "ex. Renault" })}
            {text("model", "Modèle", { required: true, placeholder: category === "agricultural" ? "ex. 6R 150" : "ex. Clio V" })}
            {text("serialNumber", serial.label, { hint: serial.hint })}
            {text("registration", "Immatriculation", { placeholder: "AB-123-CD" })}
            {text("year", "Année", { inputMode: "numeric", placeholder: "2024" })}
            <div className="grid grid-cols-[1fr_auto] gap-2">
              {text("meterValue", "Compteur", { inputMode: "numeric", hint: "Relevé à la vente ou au dernier passage." })}
              <Field label="Unité" htmlFor="meterUnit" error={err("meterUnit")}>
                <Select id="meterUnit" defaultValue={String(defaults.meterUnit ?? "")} {...register("meterUnit")}>
                  <option value="">—</option>
                  {METER_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {METER_UNIT_LABELS[u]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Vente et garantie" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Facture de vente"
              htmlFor="salesDocumentId"
              error={err("salesDocumentId")}
              hint={invoices.length ? "Factures émises à ce client." : "Aucune facture émise à ce client pour l'instant."}
            >
              <Select id="salesDocumentId" defaultValue={String(defaults.salesDocumentId ?? "")} {...register("salesDocumentId")}>
                <option value="">— Aucune —</option>
                {invoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.number} du {frDate(i.issueDate)}
                  </option>
                ))}
              </Select>
            </Field>
            {text("soldOn", "Date de vente", { type: "date" })}
            {text("warrantyEndsOn", "Fin de garantie", { type: "date" })}
            <Field label="Notes" htmlFor="notes" error={err("notes")} className="sm:col-span-2">
              <Textarea id="notes" rows={3} defaultValue={String(defaults.notes ?? "")} {...register("notes")} />
            </Field>
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
            {id ? "Enregistrer" : "Ajouter au parc"}
          </Button>
        </div>
      )}
    </form>
  );
}
