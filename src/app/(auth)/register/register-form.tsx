"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { registerSchema } from "@/lib/schemas";
import { registerAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

type Values = z.input<typeof registerSchema>;

export function RegisterForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState, setError: setFieldError } = useForm<Values>({
    resolver: zodResolver(registerSchema),
    mode: "onTouched",
  });

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      setError(null);
      const result = await registerAction(values);
      if (result && !result.ok) {
        setError(result.error);
        for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
          setFieldError(field as keyof Values, { message });
        }
      }
    }),
  );

  const e = formState.errors;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {error && <FormAlert>{error}</FormAlert>}
      <Field label="Nom complet" htmlFor="fullName" error={e.fullName?.message}>
        <Input id="fullName" autoComplete="name" autoFocus aria-invalid={!!e.fullName} {...register("fullName")} />
      </Field>
      <Field label="Adresse e-mail" htmlFor="email" error={e.email?.message}>
        <Input id="email" type="email" autoComplete="email" aria-invalid={!!e.email} {...register("email")} />
      </Field>
      <Field label="Mot de passe" htmlFor="password" error={e.password?.message} hint="12 caractères au minimum. Une phrase de passe est idéale.">
        <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!e.password} {...register("password")} />
      </Field>
      <Button type="submit" className="w-full" loading={pending}>
        Créer mon compte
      </Button>
    </form>
  );
}
