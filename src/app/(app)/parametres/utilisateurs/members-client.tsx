"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { addMemberSchema, MEMBER_ROLES } from "@/lib/schemas";
import { addMemberAction, changeMemberRoleAction } from "@/app/actions/company";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form-controls";

const ROLE_LABELS: Record<(typeof MEMBER_ROLES)[number], string> = {
  owner: "Propriétaire",
  admin: "Administrateur",
  accountant: "Comptable",
  sales: "Commercial",
  cashier: "Caissier",
  viewer: "Lecture seule",
};

type Values = z.input<typeof addMemberSchema>;

export function AddMemberForm({ canGrantOwner }: { canGrantOwner: boolean }) {
  const [pending, startTransition] = useTransition();
  const { register, handleSubmit, formState, reset, setError } = useForm<Values>({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { role: "viewer" },
  });

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      const result = await addMemberAction(values);
      if (result.ok) {
        toast.success(result.message);
        reset({ email: "", role: "viewer" });
      } else {
        toast.error(result.error);
        if (result.fieldErrors?.email) setError("email", { message: result.fieldErrors.email });
      }
    }),
  );

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="flex flex-wrap items-start gap-3 px-5 py-4">
      <Field label="Adresse e-mail" htmlFor="member-email" error={formState.errors.email?.message} className="min-w-64 flex-1">
        <Input id="member-email" type="email" aria-invalid={!!formState.errors.email} {...register("email")} />
      </Field>
      <Field label="Rôle" htmlFor="member-role" className="w-48">
        <Select id="member-role" {...register("role")}>
          {MEMBER_ROLES.filter((r) => canGrantOwner || r !== "owner").map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" loading={pending} className="mt-6">
        Ajouter
      </Button>
    </form>
  );
}

export function RoleSelect({ userId, role, canGrantOwner }: { userId: string; role: string; canGrantOwner: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Select
      aria-label="Rôle"
      className="h-8 w-44"
      defaultValue={role}
      disabled={pending || (role === "owner" && !canGrantOwner)}
      onChange={(e) => {
        const next = e.target.value;
        const select = e.target;
        startTransition(async () => {
          const result = await changeMemberRoleAction(userId, next);
          if (result.ok) toast.success(result.message);
          else {
            toast.error(result.error);
            select.value = role;
          }
        });
      }}
    >
      {MEMBER_ROLES.filter((r) => canGrantOwner || r !== "owner" || role === "owner").map((r) => (
        <option key={r} value={r}>
          {ROLE_LABELS[r]}
        </option>
      ))}
    </Select>
  );
}
