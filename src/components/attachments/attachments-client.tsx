"use client";

import { useRef, useState, useTransition } from "react";
import { Paperclip, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { removeAttachmentAction, uploadAttachmentAction } from "@/app/actions/attachments";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const MAX = 10 * 1024 * 1024;

export function AttachmentUpload({ entityType, entityId, path }: { entityType: string; entityId: string; path: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState<string | null>(null);
  return (
    <form
      method="post"
      encType="multipart/form-data"
      className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        const file = input.current?.files?.[0];
        if (!file) return;
        if (file.size > MAX) return void toast.error("Fichier trop volumineux (10 Mo au maximum).");
        const fd = new FormData();
        fd.set("entityType", entityType);
        fd.set("entityId", entityId);
        fd.set("path", path);
        fd.set("file", file);
        startTransition(async () => {
          const r = await uploadAttachmentAction(fd);
          if (!r.ok) return void toast.error(r.error);
          toast.success(r.message);
          if (input.current) input.current.value = "";
          setName(null);
        });
      }}
    >
      <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-foreground-muted hover:text-foreground">
        <Paperclip className="size-4" aria-hidden />
        <span className="max-w-60 truncate">{name ?? "Choisir un fichier…"}</span>
        <input
          ref={input}
          type="file"
          name="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={(e) => setName(e.target.files?.[0]?.name ?? null)}
        />
      </label>
      <Button type="submit" size="sm" variant="secondary" loading={pending} disabled={!name}>
        Joindre
      </Button>
    </form>
  );
}

export function RemoveAttachmentButton({ id, name, path }: { id: string; name: string; path: string }) {
  return (
    <ConfirmDialog
      title="Retirer la pièce jointe ?"
      description={`« ${name} » ne sera plus affichée. Le retrait est tracé dans le journal d'audit.`}
      confirmLabel="Retirer"
      tone="danger"
      onConfirm={async () => {
        const r = await removeAttachmentAction(id, path);
        if (r.ok) toast.success(r.message);
        else toast.error(r.error);
        return r.ok;
      }}
      trigger={
        <button type="button" className="rounded p-1 text-foreground-subtle hover:bg-muted hover:text-danger" aria-label={`Retirer ${name}`}>
          <Trash2 className="size-3.5" />
        </button>
      }
    />
  );
}
