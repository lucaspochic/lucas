"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { createCompanySchema, VAT_REGIME_LABELS, VAT_REGIMES } from "@/lib/schemas";
import { createCompanyAction } from "@/app/actions/company";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

type Values = z.input<typeof createCompanySchema>;

export function OnboardingForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(createCompanySchema),
    mode: "onTouched",
    defaultValues: { vatRegime: "reel_normal" },
  });
  const e = formState.errors;

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      setError(null);
      const result = await createCompanyAction(values);
      if (result && !result.ok) setError(result.error);
    }),
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {error && <FormAlert>{error}</FormAlert>}
      <Field label="Raison sociale" htmlFor="legalName" required error={e.legalName?.message}>
        <Input id="legalName" autoFocus aria-invalid={!!e.legalName} {...register("legalName")} />
      </Field>
      <Field label="SIREN" htmlFor="siren" error={e.siren?.message} hint="9 chiffres. Facultatif à ce stade.">
        <Input id="siren" inputMode="numeric" aria-invalid={!!e.siren} {...register("siren")} />
      </Field>
      <Field label="Régime de TVA" htmlFor="vatRegime" error={e.vatRegime?.message}>
        <Select id="vatRegime" {...register("vatRegime")}>
          {VAT_REGIMES.map((r) => (
            <option key={r} value={r}>
              {VAT_REGIME_LABELS[r]}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" className="w-full" loading={pending}>
        Créer l&apos;entreprise
      </Button>
    </form>
  );
}
