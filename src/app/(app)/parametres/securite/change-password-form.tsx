"use client";

import { useTransition } from "react";
import { useForm, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { changePasswordSchema } from "@/lib/schemas";
import { changePasswordAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";

type Values = z.input<typeof changePasswordSchema>;

export function ChangePasswordForm() {
  const [pending, startTransition] = useTransition();
  const { register, handleSubmit, formState, setError } = useForm<Values>({ resolver: zodResolver(changePasswordSchema), mode: "onTouched" });
  const e = formState.errors;

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      const result = await changePasswordAction(values);
      if (result && !result.ok) {
        toast.error(result.error);
        for (const [field, message] of Object.entries(result.fieldErrors ?? {})) setError(field as FieldPath<Values>, { message });
      }
    }),
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Field label="Mot de passe actuel" htmlFor="currentPassword" error={e.currentPassword?.message}>
        <Input id="currentPassword" type="password" autoComplete="current-password" aria-invalid={!!e.currentPassword} {...register("currentPassword")} />
      </Field>
      <Field label="Nouveau mot de passe" htmlFor="newPassword" error={e.newPassword?.message} hint="12 caractères au minimum.">
        <Input id="newPassword" type="password" autoComplete="new-password" aria-invalid={!!e.newPassword} {...register("newPassword")} />
      </Field>
      <Field label="Confirmation" htmlFor="confirmPassword" error={e.confirmPassword?.message}>
        <Input id="confirmPassword" type="password" autoComplete="new-password" aria-invalid={!!e.confirmPassword} {...register("confirmPassword")} />
      </Field>
      <Button type="submit" loading={pending}>
        Modifier le mot de passe
      </Button>
    </form>
  );
}
