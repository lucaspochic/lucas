"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import { addAttachment, ATTACHMENT_MAX_BYTES, removeAttachment, type AttachmentEntity } from "@/server/services/attachments";
import { AppError } from "@/server/errors";

const ENTITIES: AttachmentEntity[] = ["expense", "sales_document", "third_party"];

/** Envoi d'une pièce jointe (FormData : entityType, entityId, path, file). */
export async function uploadAttachmentAction(fd: FormData): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const entityType = String(fd.get("entityType")) as AttachmentEntity;
    if (!ENTITIES.includes(entityType)) throw new AppError("VALIDATION", "Type d'élément invalide.");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("VALIDATION", "Choisissez un fichier.");
    if (file.size > ATTACHMENT_MAX_BYTES) throw new AppError("VALIDATION", "Fichier trop volumineux (10 Mo au maximum).");
    const row = await addAttachment(await getDb(), ctx, {
      entityType,
      entityId: String(fd.get("entityId")),
      fileName: file.name,
      data: Buffer.from(await file.arrayBuffer()),
    });
    revalidatePath(String(fd.get("path") || "/"));
    return { ok: true, message: `« ${row.fileName} » ajouté.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function removeAttachmentAction(id: string, pathToRevalidate: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await removeAttachment(await getDb(), ctx, String(id));
    revalidatePath(String(pathToRevalidate || "/"));
    return { ok: true, message: "Pièce jointe retirée." };
  } catch (err) {
    return toActionError(err);
  }
}
