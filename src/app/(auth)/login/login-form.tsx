"use client";

import { useActionState } from "react";
import { loginFormAction, type CredentialFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

/** Formulaire en amélioration progressive : POST garanti, même avant le chargement du JavaScript. */
export function LoginForm() {
  const [state, action, pending] = useActionState<CredentialFormState, FormData>(loginFormAction, {});
  return (
    <form action={action} className="space-y-4">
      {state.error && <FormAlert>{state.error}</FormAlert>}
      <Field label="Adresse e-mail" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus defaultValue={state.values?.email} />
      </Field>
      <Field label="Mot de passe" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
      </Field>
      <Button type="submit" className="w-full" loading={pending}>
        Se connecter
      </Button>
    </form>
  );
}
