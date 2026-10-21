import { FileText, ImageIcon, Lock } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import type { CompanyContext } from "@/server/security/permissions";
import { can } from "@/server/security/permissions";
import { listAttachments, type AttachmentEntity } from "@/server/services/attachments";
import { AttachmentUpload, RemoveAttachmentButton } from "./attachments-client";

const WRITE = { expense: "purchases.write", sales_document: "sales.write", third_party: "thirdparties.write" } as const;

const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} Ko` : `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`);

/** Pièces jointes d'un élément : liste, consultation, ajout et retrait selon les droits. */
export async function AttachmentsPanel({ ctx, entityType, entityId, path }: { ctx: CompanyContext; entityType: AttachmentEntity; entityId: string; path: string }) {
  const { rows, locked } = await listAttachments(await getDb(), ctx, entityType, entityId);
  const canWrite = can(ctx, WRITE[entityType]);
  return (
    <Card>
      <CardHeader
        title="Pièces jointes"
        description={locked ? "Justificatifs d'une opération validée : ils sont conservés et ne peuvent pas être retirés." : "PDF, PNG, JPEG ou WebP, 10 Mo au maximum."}
      />
      {rows.length > 0 && (
        <ul className="divide-y divide-border text-[13px]">
          {rows.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-5 py-2.5">
              {a.mimeType === "application/pdf" ? <FileText className="size-4 text-foreground-muted" aria-hidden /> : <ImageIcon className="size-4 text-foreground-muted" aria-hidden />}
              <a href={`/api/pieces-jointes/${a.id}`} target="_blank" rel="noopener" className="min-w-0 flex-1 truncate font-medium hover:text-accent">
                {a.fileName}
              </a>
              <span className="text-xs text-foreground-muted">{size(a.size)}</span>
              <a href={`/api/pieces-jointes/${a.id}?telecharger=1`} className="text-xs text-foreground-muted hover:text-foreground">
                Télécharger
              </a>
              {canWrite && (locked ? <Lock className="size-3.5 text-foreground-subtle" aria-label="Conservée" /> : <RemoveAttachmentButton id={a.id} name={a.fileName} path={path} />)}
            </li>
          ))}
        </ul>
      )}
      {canWrite && <AttachmentUpload entityType={entityType} entityId={entityId} path={path} />}
      {!canWrite && rows.length === 0 && <p className="px-5 py-4 text-[13px] text-foreground-muted">Aucune pièce jointe.</p>}
    </Card>
  );
}
