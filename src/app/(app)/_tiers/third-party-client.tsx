"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Archive, ArchiveRestore, Mail, Phone, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { contactSchema, type ContactInput } from "@/lib/schemas";
import { addContactAction, archiveThirdPartyAction, removeContactAction } from "@/app/actions/third-parties";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox, Field, Input } from "@/components/ui/form-controls";

export function ArchiveThirdPartyButton({ id, archived, name }: { id: string; archived: boolean; name: string }) {
  return (
    <ConfirmDialog
      trigger={
        <Button variant="secondary">
          {archived ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
          {archived ? "Restaurer" : "Archiver"}
        </Button>
      }
      title={archived ? `Restaurer « ${name} » ?` : `Archiver « ${name} » ?`}
      description={
        archived
          ? "La fiche redeviendra disponible dans les listes et les documents."
          : "La fiche n'apparaîtra plus dans les listes ni dans les nouveaux documents. Elle reste consultable et peut être restaurée. Les fiches ne sont jamais supprimées, pour préserver l'historique comptable."
      }
      confirmLabel={archived ? "Restaurer" : "Archiver"}
      onConfirm={async () => {
        const r = await archiveThirdPartyAction(id, !archived);
        if (r.ok) toast.success(r.message);
        else toast.error(r.error);
      }}
    />
  );
}

interface ContactView {
  id: string;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
}

export function ContactsPanel({ thirdPartyId, contacts, canWrite }: { thirdPartyId: string; contacts: ContactView[]; canWrite: boolean }) {
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();
  const { register, handleSubmit, formState, reset } = useForm<ContactInput>({
    resolver: zodResolver(contactSchema),
    defaultValues: { fullName: "", isPrimary: contacts.length === 0 },
  });
  const e = formState.errors;

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      const r = await addContactAction(thirdPartyId, values);
      if (r.ok) {
        toast.success(r.message);
        reset({ fullName: "", isPrimary: false });
        setAdding(false);
      } else toast.error(r.error);
    }),
  );

  return (
    <Card>
      <CardHeader
        title="Contacts"
        actions={
          canWrite && !adding ? (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> Ajouter
            </Button>
          ) : undefined
        }
      />
      {contacts.length === 0 && !adding && <p className="px-5 py-4 text-[13px] text-foreground-muted">Aucun contact.</p>}
      {contacts.length > 0 && (
        <ul className="divide-y divide-border">
          {contacts.map((c) => (
            <li key={c.id} className="flex items-start gap-3 px-5 py-3 text-[13px]">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-medium">
                  {c.fullName}
                  {c.isPrimary && <Star className="size-3.5 fill-accent text-accent" aria-label="Contact principal" />}
                </p>
                {c.jobTitle && <p className="text-foreground-muted">{c.jobTitle}</p>}
                <div className="mt-1 flex flex-wrap gap-x-3 text-foreground-muted">
                  {c.email && (
                    <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 hover:text-accent">
                      <Mail className="size-3.5" aria-hidden /> {c.email}
                    </a>
                  )}
                  {c.phone && (
                    <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 hover:text-accent">
                      <Phone className="size-3.5" aria-hidden /> {c.phone}
                    </a>
                  )}
                </div>
              </div>
              {canWrite && (
                <ConfirmDialog
                  trigger={
                    <button type="button" className="rounded p-1 text-foreground-subtle hover:bg-muted hover:text-danger" aria-label={`Supprimer ${c.fullName}`}>
                      <Trash2 className="size-4" />
                    </button>
                  }
                  title={`Supprimer le contact « ${c.fullName} » ?`}
                  description="Cette suppression est tracée dans le journal d'audit."
                  confirmLabel="Supprimer"
                  tone="danger"
                  onConfirm={async () => {
                    const r = await removeContactAction(thirdPartyId, c.id);
                    if (r.ok) toast.success(r.message);
                    else toast.error(r.error);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <CardBody className="border-t border-border">
          <form method="post" onSubmit={onSubmit} noValidate className="space-y-3">
            <Field label="Nom" htmlFor="c-fullName" error={e.fullName?.message} required>
              <Input id="c-fullName" autoFocus aria-invalid={!!e.fullName} {...register("fullName")} />
            </Field>
            <Field label="Fonction" htmlFor="c-jobTitle">
              <Input id="c-jobTitle" {...register("jobTitle")} />
            </Field>
            <Field label="E-mail" htmlFor="c-email" error={e.email?.message}>
              <Input id="c-email" type="email" aria-invalid={!!e.email} {...register("email")} />
            </Field>
            <Field label="Téléphone" htmlFor="c-phone">
              <Input id="c-phone" type="tel" {...register("phone")} />
            </Field>
            <Checkbox label="Contact principal" {...register("isPrimary")} />
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Annuler
              </Button>
              <Button type="submit" size="sm" loading={pending}>
                Ajouter le contact
              </Button>
            </div>
          </form>
        </CardBody>
      )}
    </Card>
  );
}
