"use client";

import { Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import { archiveEquipmentAction } from "@/app/actions/equipment";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function ArchiveEquipmentButton({ id, archived, name }: { id: string; archived: boolean; name: string }) {
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
          ? "Le matériel réapparaîtra dans le parc du client."
          : "Matériel détruit, exporté ou perdu de vue : il sort du parc actif mais sa fiche et son historique sont conservés."
      }
      confirmLabel={archived ? "Restaurer" : "Archiver"}
      onConfirm={async () => {
        const r = await archiveEquipmentAction(id, !archived);
        if (r.ok) toast.success(r.message);
        else toast.error(r.error);
      }}
    />
  );
}
