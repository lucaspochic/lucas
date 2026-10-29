"use client";

import { useState, useTransition } from "react";
import { useForm, useWatch, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { PARTY_TYPE_LABELS, PARTY_TYPES, thirdPartySchema, type ThirdPartyInput } from "@/lib/schemas";
import { createThirdPartyAction, updateThirdPartyAction } from "@/app/actions/third-parties";
import type { PartySection } from "@/lib/party-sections";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

export function ThirdPartyForm({
  id,
  section,
  defaults,
  readOnly = false,
  defaultTermsDays,
}: {
  id?: string;
  /** Rubrique d'origine : la fiche créée s'y ouvre si le rôle choisi le permet. */
  section: PartySection;
  defaults: ThirdPartyInput;
  readOnly?: boolean;
  defaultTermsDays: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // shouldUnregister : les champs masqués (SIREN d'un particulier, livraison) ne sont pas envoyés.
  const form = useForm<ThirdPartyInput>({
    resolver: zodResolver(thirdPartySchema),
    defaultValues: defaults,
    mode: "onTouched",
    shouldUnregister: true,
  });
  const { register, handleSubmit, formState, control, setError: setFieldError } = form;
  const partyType = useWatch({ control, name: "partyType" });
  const hasShipping = useWatch({ control, name: "hasShippingAddress" });
  const errors = formState.errors as Record<string, { message?: string } | undefined>;
  const err = (n: string) => errors[n]?.message;

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      setError(null);
      const result = id ? await updateThirdPartyAction(id, values) : await createThirdPartyAction(values, section);
      if (result?.ok) {
        toast.success(result.message ?? "Enregistré.");
        form.reset(values);
      } else if (result) {
        setError(result.error);
        for (const [f, message] of Object.entries(result.fieldErrors ?? {})) setFieldError(f as FieldPath<ThirdPartyInput>, { message });
      }
    }),
  );

  const text = (name: FieldPath<ThirdPartyInput>, label: string, extra: { hint?: string; required?: boolean; inputMode?: "numeric" | "email" | "tel"; className?: string; placeholder?: string } = {}) => (
    <Field label={label} htmlFor={name} error={err(name)} hint={extra.hint} required={extra.required} className={extra.className}>
      <Input
        id={name}
        inputMode={extra.inputMode}
        placeholder={extra.placeholder}
        aria-invalid={!!err(name)}
        defaultValue={String(defaults[name as keyof ThirdPartyInput] ?? "")}
        {...register(name)}
      />
    </Field>
  );

  const isIndividual = partyType === "individual";

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="space-y-6">
      {error && <FormAlert>{error}</FormAlert>}
      <fieldset disabled={readOnly || pending} className="space-y-6">
        <Card>
          <CardHeader title="Identité" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Type" htmlFor="partyType" error={err("partyType")} required>
              <Select id="partyType" defaultValue={String(defaults.partyType ?? "")} {...register("partyType")}>
                {PARTY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {PARTY_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="space-y-1.5">
              <span className="block text-[13px] font-medium">Rôle</span>
              <div className="flex h-9 items-center gap-5">
                <Checkbox label="Client" {...register("isCustomer")} />
                <Checkbox label="Fournisseur" {...register("isSupplier")} />
              </div>
              {err("isCustomer") && <p className="text-xs text-danger">{err("isCustomer")}</p>}
            </div>
            {text("name", isIndividual ? "Nom et prénom" : "Raison sociale", { required: true })}
            {text("code", "Code", { hint: id ? undefined : "Laisser vide pour une attribution automatique." })}
            {!isIndividual && (
              <>
                {text("legalForm", "Forme juridique")}
                {text("siren", "SIREN", {
                  inputMode: "numeric",
                  hint: "Mention obligatoire sur les factures électroniques adressées à un professionnel français.",
                })}
                {text("siret", "SIRET", { inputMode: "numeric" })}
                {text("vatNumber", "N° de TVA intracommunautaire")}
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Coordonnées" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {text("email", "E-mail", { inputMode: "email" })}
            {text("phone", "Téléphone", { inputMode: "tel" })}
            {text("billingLine1", "Adresse de facturation")}
            {text("billingLine2", "Complément")}
            {text("billingPostalCode", "Code postal", { inputMode: "numeric" })}
            {text("billingCity", "Ville")}
            {text("billingCountry", "Pays (code ISO)", { hint: "FR pour la France." })}
            <div className="flex items-end pb-2">
              <Checkbox label="Adresse de livraison différente" {...register("hasShippingAddress")} />
            </div>
            {hasShipping && (
              <>
                {text("shippingLine1", "Adresse de livraison", { required: true })}
                {text("shippingLine2", "Complément")}
                {text("shippingPostalCode", "Code postal", { required: true, inputMode: "numeric" })}
                {text("shippingCity", "Ville", { required: true })}
                {text("shippingCountry", "Pays (code ISO)", { placeholder: "FR" })}
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Conditions et notes" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {text("paymentTermsDays", "Délai de paiement (jours)", {
              inputMode: "numeric",
              placeholder: `Par défaut : ${defaultTermsDays}`,
              hint: "Vide = délai par défaut de l'entreprise.",
            })}
            <div />
            <Field label="Notes internes" htmlFor="notes" error={err("notes")} className="sm:col-span-2" hint="Non imprimées sur les documents.">
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
            {id ? "Enregistrer" : "Créer la fiche"}
          </Button>
        </div>
      )}
    </form>
  );
}
