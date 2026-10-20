"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { loginSchema } from "@/lib/schemas";
import { loginAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

type Values = z.input<typeof loginSchema>;

export function LoginForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(loginSchema), mode: "onTouched" });

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      setError(null);
      const result = await loginAction(values);
      if (result && !result.ok) setError(result.error);
    }),
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {error && <FormAlert>{error}</FormAlert>}
      <Field label="Adresse e-mail" htmlFor="email" error={formState.errors.email?.message}>
        <Input id="email" type="email" autoComplete="username" autoFocus aria-invalid={!!formState.errors.email} {...register("email")} />
      </Field>
      <Field label="Mot de passe" htmlFor="password" error={formState.errors.password?.message}>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={!!formState.errors.password}
          {...register("password")}
        />
      </Field>
      <Button type="submit" className="w-full" loading={pending}>
        Se connecter
      </Button>
    </form>
  );
}
