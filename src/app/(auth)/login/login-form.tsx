"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginFormAction, mfaFormAction, type CredentialFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

/** Formulaire en amélioration progressive : POST garanti, même avant le chargement du JavaScript. */
export function LoginForm() {
  const [state, action, pending] = useActionState<CredentialFormState, FormData>(loginFormAction, {});
  if (state.mfa) return <MfaStep />;
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

/** Seconde étape : code à 6 chiffres de l'application, ou code de secours. */
function MfaStep() {
  const [state, action, pending] = useActionState<CredentialFormState, FormData>(mfaFormAction, { mfa: true });
  if (state.restart) {
    return (
      <div className="space-y-4">
        <FormAlert>{state.error}</FormAlert>
        <Link href="/login" className="block text-center text-sm font-medium text-accent hover:underline">
          Recommencer la connexion
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-4">
      {state.error && <FormAlert>{state.error}</FormAlert>}
      <p className="text-sm text-foreground-muted">
        Saisissez le code à 6 chiffres affiché par votre application d&apos;authentification, ou l&apos;un de vos codes de secours.
      </p>
      <Field label="Code de vérification" htmlFor="code">
        <Input id="code" name="code" autoComplete="one-time-code" inputMode="numeric" required autoFocus maxLength={20} className="text-center tracking-widest" />
      </Field>
      <Button type="submit" className="w-full" loading={pending}>
        Vérifier
      </Button>
    </form>
  );
}
