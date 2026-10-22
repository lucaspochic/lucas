"use client";

import { useEffect, useRef, useTransition } from "react";
import { useForm, useWatch, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { companySchema, VAT_REGIME_LABELS, VAT_REGIMES, type CompanyInput } from "@/lib/schemas";
import { updateCompanyAction } from "@/app/actions/company";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form-controls";
import { ActivitiesPicker } from "@/components/activities-picker";
import { MODULE_INFO, OPTIONAL_MODULES, suggestedModules } from "@/lib/activities";

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const LEGAL_FORMS = ["Entreprise individuelle", "EURL", "SARL", "SAS", "SASU", "SA", "SNC", "SCI", "Association", "Autre"];
const PENALTY_SUGGESTION =
  "En cas de retard de paiement : pénalités au taux directeur de la BCE majoré de 10 points, exigibles sans rappel, et indemnité forfaitaire pour frais de recouvrement de 40 € (art. L. 441-10 et D. 441-5 du code de commerce). Pas d'escompte pour paiement anticipé.";

interface VatRateView {
  id: string;
  label: string;
  rate: string;
  exemptionReason: string | null;
}

export function CompanyForm({ defaults, readOnly, vatRates }: { defaults: CompanyInput; readOnly: boolean; vatRates: VatRateView[] }) {
  const [pending, startTransition] = useTransition();
  const form = useForm<CompanyInput>({ resolver: zodResolver(companySchema), defaultValues: defaults, mode: "onTouched" });
  const { register, handleSubmit, formState, setError, setValue, control } = form;
  const e = formState.errors as Record<string, { message?: string } | undefined>;
  const err = (name: string) => e[name]?.message;
  const vatRegime = useWatch({ control, name: "vatRegime" });
  const latePenaltyText = useWatch({ control, name: "latePenaltyText" });
  const activities = useWatch({ control, name: "activities" });

  // Cocher un domaine d’activité coche les modules qu’il propose (on peut ensuite les décocher).
  const previousActivities = useRef(defaults.activities);
  useEffect(() => {
    const before = new Set(Array.isArray(previousActivities.current) ? (previousActivities.current as string[]) : []);
    const now = Array.isArray(activities) ? (activities as string[]) : [];
    previousActivities.current = now;
    const added = suggestedModules(now.filter((a) => !before.has(a)));
    if (added.length === 0) return;
    const current = form.getValues("modules");
    const modules = new Set(Array.isArray(current) ? (current as string[]) : []);
    added.forEach((m) => modules.add(m));
    setValue("modules", OPTIONAL_MODULES.filter((m) => modules.has(m)), { shouldDirty: true });
  }, [activities, form, setValue]);

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      const result = await updateCompanyAction(values);
      if (result.ok) {
        toast.success(result.message ?? "Enregistré.");
        form.reset(values);
      } else {
        toast.error(result.error);
        for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
          setError(field as FieldPath<CompanyInput>, { message });
        }
      }
    }),
  );

  const text = (name: FieldPath<CompanyInput>, label: string, opts: { hint?: string; required?: boolean; placeholder?: string; inputMode?: "numeric" | "email" | "tel" | "url" } = {}) => (
    <Field label={label} htmlFor={name} error={err(name)} hint={opts.hint} required={opts.required}>
      <Input
        id={name}
        aria-invalid={!!err(name)}
        placeholder={opts.placeholder}
        inputMode={opts.inputMode}
        // Valeur présente dès le rendu serveur (sinon champ vide jusqu'à l'hydratation).
        defaultValue={String(defaults[name as keyof CompanyInput] ?? "")}
        {...register(name)}
      />
    </Field>
  );

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="space-y-6">
      <fieldset disabled={readOnly || pending} className="space-y-6">
        <Card>
          <CardHeader title="Identité" description="Mentions obligatoires sur les factures." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {text("legalName", "Raison sociale", { required: true })}
            {text("tradeName", "Nom commercial")}
            <Field label="Forme juridique" htmlFor="legalForm" error={err("legalForm")}>
              <Select id="legalForm" defaultValue={String(defaults.legalForm ?? "")} {...register("legalForm")}>
                <option value="">—</option>
                {LEGAL_FORMS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
            {text("shareCapital", "Capital social (€)", { placeholder: "10000.00", hint: "Pour les sociétés." })}
            {text("siren", "SIREN", { inputMode: "numeric" })}
            {text("siret", "SIRET du siège", { inputMode: "numeric" })}
            {text("nafCode", "Code APE / NAF", { placeholder: "6201Z" })}
            {text("rcsCity", "Ville d'immatriculation au RCS / RM", { placeholder: "RCS Lyon" })}
          </CardBody>
        </Card>

        <Card id="activite">
          <CardHeader
            title="Activité et modules"
            description="Vos domaines d’activité adaptent le menu : les modules utiles à votre métier apparaissent et passent en tête."
          />
          <CardBody className="space-y-5">
            <fieldset className="space-y-2">
              <legend className="text-[13px] font-medium">Domaines d’activité</legend>
              <ActivitiesPicker registration={register("activities")} columns={2} initial={Array.isArray(defaults.activities) ? (defaults.activities as string[]) : []} />
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-[13px] font-medium">Modules complémentaires</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {OPTIONAL_MODULES.map((m) => (
                  <label key={m} className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2 text-[13px] has-[:checked]:border-accent">
                    <input type="checkbox" value={m} defaultChecked={Array.isArray(defaults.modules) && (defaults.modules as string[]).includes(m)} className="mt-0.5 size-4 shrink-0 rounded border-border accent-[var(--color-accent)]" {...register("modules")} />
                    <span>
                      <span className="block font-medium">{MODULE_INFO[m].label}</span>
                      <span className="block text-xs text-foreground-muted">{MODULE_INFO[m].description}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-foreground-muted">
                Désactiver un module le retire du menu sans rien effacer ; un module qui contient déjà des données reste affiché.
              </p>
            </fieldset>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Coordonnées" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {text("addressLine1", "Adresse")}
            {text("addressLine2", "Complément d'adresse")}
            {text("postalCode", "Code postal", { inputMode: "numeric" })}
            {text("city", "Ville")}
            {text("email", "E-mail", { inputMode: "email" })}
            {text("phone", "Téléphone", { inputMode: "tel" })}
            {text("website", "Site web", { inputMode: "url" })}
            {text("country", "Pays (code ISO)", { hint: "FR pour la France." })}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Fiscalité" description="Détermine les taux et mentions appliqués aux documents." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Régime de TVA" htmlFor="vatRegime" error={err("vatRegime")}>
              <Select id="vatRegime" defaultValue={String(defaults.vatRegime ?? "")} {...register("vatRegime")}>
                {VAT_REGIMES.map((r) => (
                  <option key={r} value={r}>
                    {VAT_REGIME_LABELS[r]}
                  </option>
                ))}
              </Select>
            </Field>
            {text("vatNumber", "N° de TVA intracommunautaire", { placeholder: "FR00123456789" })}
            <Field label="Début d'exercice" htmlFor="fiscalYearStartMonth" error={err("fiscalYearStartMonth")}>
              <Select id="fiscalYearStartMonth" defaultValue={String(defaults.fiscalYearStartMonth ?? "")} {...register("fiscalYearStartMonth")}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    1er {m}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" className="size-4 accent-[var(--color-accent)]" disabled={vatRegime === "franchise_en_base"} {...register("vatOnDebits")} />
                Option pour le paiement de la TVA d&apos;après les débits
              </label>
            </div>
            {err("vatOnDebits") && <p className="text-xs text-danger sm:col-span-2">{err("vatOnDebits")}</p>}
            <div className="sm:col-span-2">
              <p className="mb-2 text-[13px] font-medium">Taux de TVA disponibles</p>
              <div className="flex flex-wrap gap-2">
                {vatRates.map((r) => (
                  <Badge key={r.id} tone={r.exemptionReason ? "warning" : "neutral"}>
                    {r.label}
                    {r.exemptionReason ? ` — ${r.exemptionReason}` : ""}
                  </Badge>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Règlement" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Délai de paiement (jours)" htmlFor="paymentTermsDays" error={err("paymentTermsDays")} hint="60 jours maximum à compter de la date d'émission.">
              <Input id="paymentTermsDays" type="number" min={0} max={60} {...register("paymentTermsDays")} />
            </Field>
            <div />
            {text("iban", "IBAN")}
            {text("bic", "BIC")}
            <Field label="Pénalités de retard" htmlFor="latePenaltyText" error={err("latePenaltyText")} className="sm:col-span-2">
              <Textarea id="latePenaltyText" rows={3} {...register("latePenaltyText")} />
              {!latePenaltyText && !readOnly && (
                <button
                  type="button"
                  className="text-xs font-medium text-accent hover:underline"
                  onClick={() => setValue("latePenaltyText", PENALTY_SUGGESTION, { shouldDirty: true })}
                >
                  Insérer la mention standard
                </button>
              )}
            </Field>
            <Field label="Mentions complémentaires" htmlFor="legalMentions" error={err("legalMentions")} className="sm:col-span-2" hint="Ex. assurance professionnelle, mentions propres à votre activité.">
              <Textarea id="legalMentions" rows={3} {...register("legalMentions")} />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Numérotation"
            description="Numéros continus par type de document et par exercice, ex. FA-2026-00001. Un préfixe modifié ne s'applique qu'aux documents futurs."
          />
          <CardBody className="grid gap-4 sm:grid-cols-3">
            {text("invoicePrefix", "Préfixe factures")}
            {text("creditNotePrefix", "Préfixe avoirs")}
            {text("quotePrefix", "Préfixe devis")}
          </CardBody>
        </Card>
      </fieldset>

      {!readOnly && (
        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
          <Button type="button" variant="secondary" disabled={!formState.isDirty || pending} onClick={() => form.reset(defaults)}>
            Annuler
          </Button>
          <Button type="submit" loading={pending} disabled={!formState.isDirty}>
            Enregistrer
          </Button>
        </div>
      )}
    </form>
  );
}
