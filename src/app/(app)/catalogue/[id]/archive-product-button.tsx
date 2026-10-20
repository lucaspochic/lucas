"use client";

import { Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import { archiveProductAction } from "@/app/actions/products";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function ArchiveProductButton({ id, archived, name }: { id: string; archived: boolean; name: string }) {
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
          ? "L'article sera de nouveau proposé dans les devis et factures."
          : "L'article ne sera plus proposé dans les nouveaux documents. Les documents existants ne sont pas modifiés."
      }
      confirmLabel={archived ? "Restaurer" : "Archiver"}
      onConfirm={async () => {
        const r = await archiveProductAction(id, !archived);
        if (r.ok) toast.success(r.message);
        else toast.error(r.error);
      }}
    />
  );
}
