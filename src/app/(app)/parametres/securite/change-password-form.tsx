"use client";

import { useActionState } from "react";
import { changePasswordFormAction, type CredentialFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

/** Formulaire en amélioration progressive : POST garanti, même avant le chargement du JavaScript. */
export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<CredentialFormState, FormData>(changePasswordFormAction, {});
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4">
      {state.error && <FormAlert>{state.error}</FormAlert>}
      <Field label="Mot de passe actuel" htmlFor="currentPassword" error={e.currentPassword}>
        <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required aria-invalid={!!e.currentPassword} />
      </Field>
      <Field label="Nouveau mot de passe" htmlFor="newPassword" error={e.newPassword} hint="12 caractères au minimum.">
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} aria-invalid={!!e.newPassword} />
      </Field>
      <Field label="Confirmation" htmlFor="confirmPassword" error={e.confirmPassword}>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required aria-invalid={!!e.confirmPassword} />
      </Field>
      <Button type="submit" loading={pending}>
        Modifier le mot de passe
      </Button>
    </form>
  );
}
