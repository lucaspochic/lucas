"use client";

import { useActionState } from "react";
import { registerFormAction, type CredentialFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

/** Formulaire en amélioration progressive : POST garanti, même avant le chargement du JavaScript. */
export function RegisterForm() {
  const [state, action, pending] = useActionState<CredentialFormState, FormData>(registerFormAction, {});
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4">
      {state.error && <FormAlert>{state.error}</FormAlert>}
      <Field label="Nom complet" htmlFor="fullName" error={e.fullName}>
        <Input id="fullName" name="fullName" autoComplete="name" required minLength={2} maxLength={120} autoFocus defaultValue={state.values?.fullName} aria-invalid={!!e.fullName} />
      </Field>
      <Field label="Adresse e-mail" htmlFor="email" error={e.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={state.values?.email} aria-invalid={!!e.email} />
      </Field>
      <Field label="Mot de passe" htmlFor="password" error={e.password} hint="12 caractères au minimum. Une phrase de passe est idéale.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} aria-invalid={!!e.password} />
      </Field>
      <Button type="submit" className="w-full" loading={pending}>
        Créer mon compte
      </Button>
    </form>
  );
}
