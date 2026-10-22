import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db, Executor } from "../db/client";
import { attachments, equipment, expenses, salesDocuments, thirdParties, type Attachment } from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext, type Permission } from "../security/permissions";
import { appendAuditEvent } from "./audit";
import { isUuid } from "./third-parties";

/**
 * Pièces jointes (justificatifs, contrats, scans de factures fournisseurs) :
 *  - types acceptés reconnus par leur signature binaire, jamais par l'extension ou le
 *    type annoncé par le navigateur : PDF, PNG, JPEG, WebP ; 10 Mo au maximum ;
 *  - contenu stocké hors de la base, adressé par son empreinte SHA-256 et rangé par
 *    entreprise ; l'empreinte est revérifiée à chaque lecture ;
 *  - une pièce justifiant une opération validée (dépense validée, document de vente émis)
 *    ne peut pas être retirée ; un retrait est un marquage tracé, le fichier est conservé.
 *
 * Répertoire : ATTACHMENTS_DIR (production : volume persistant et sauvegardé),
 * à défaut .data/attachments ; tests : répertoire temporaire.
 */

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export type AttachmentEntity = Attachment["entityType"];

const ENTITY_PERMISSIONS: Record<AttachmentEntity, { read: Permission; write: Permission }> = {
  expense: { read: "purchases.read", write: "purchases.write" },
  sales_document: { read: "sales.read", write: "sales.write" },
  third_party: { read: "thirdparties.read", write: "thirdparties.write" },
  equipment: { read: "thirdparties.read", write: "thirdparties.write" },
};

let testDir: string | undefined;
function storageRoot() {
  if (process.env.ATTACHMENTS_DIR) return process.env.ATTACHMENTS_DIR;
  if (process.env.VITEST) return (testDir ??= path.join(tmpdir(), `gestion-pj-${randomBytes(6).toString("hex")}`));
  return path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "attachments");
}
// Stockage hors du code : exclu du traçage des fichiers du build (sortie « standalone »).
const filePath = (companyId: string, sha256: string) => path.join(/* turbopackIgnore: true */ storageRoot(), companyId, sha256.slice(0, 2), sha256);

/** Type réel du fichier d'après ses premiers octets. */
export function detectFileType(data: Buffer): { mime: string; ext: string } | null {
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

/** Nom affiché : sans chemin ni caractère de contrôle, extension conforme au type réel. */
export function sanitizeFileName(name: string, ext: string) {
  const base = path.basename(name.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "")
    .replace(/\.[^.]*$/, "")
    .trim()
    .slice(0, 120);
  return `${base || "piece-jointe"}.${ext}`;
}

/** L'entité existe dans l'entreprise ; `locked` : elle est validée (justificatif à conserver). */
async function entityState(db: Executor, ctx: CompanyContext, type: AttachmentEntity, id: string) {
  if (!isUuid(id)) throw notFound("Élément introuvable.");
  if (type === "expense") {
    const [row] = await db.select({ status: expenses.status }).from(expenses).where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.id, id))).limit(1);
    if (!row) throw notFound("Dépense introuvable.");
    return { locked: row.status !== "draft" };
  }
  if (type === "sales_document") {
    const [row] = await db.select({ status: salesDocuments.status }).from(salesDocuments).where(and(eq(salesDocuments.companyId, ctx.companyId), eq(salesDocuments.id, id))).limit(1);
    if (!row) throw notFound("Document introuvable.");
    return { locked: row.status !== "draft" };
  }
  if (type === "equipment") {
    const [row] = await db.select({ id: equipment.id }).from(equipment).where(and(eq(equipment.companyId, ctx.companyId), eq(equipment.id, id))).limit(1);
    if (!row) throw notFound("Matériel introuvable.");
    return { locked: false };
  }
  const [row] = await db.select({ id: thirdParties.id }).from(thirdParties).where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.id, id))).limit(1);
  if (!row) throw notFound("Tiers introuvable.");
  return { locked: false };
}

async function storeFile(companyId: string, sha256: string, data: Buffer) {
  const target = filePath(companyId, sha256);
  try {
    await stat(target);
    return; // contenu identique déjà présent
  } catch {
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, target);
  }
}

export async function addAttachment(db: Db, ctx: CompanyContext, input: { entityType: AttachmentEntity; entityId: string; fileName: string; data: Buffer }) {
  const perms = ENTITY_PERMISSIONS[input.entityType];
  if (!perms) throw new AppError("VALIDATION", "Type d'élément invalide.");
  assertPermission(ctx, perms.write);
  await entityState(db, ctx, input.entityType, input.entityId);
  if (input.data.length === 0) throw new AppError("VALIDATION", "Fichier vide.");
  if (input.data.length > ATTACHMENT_MAX_BYTES) throw new AppError("VALIDATION", "Fichier trop volumineux (10 Mo au maximum).");
  const type = detectFileType(input.data);
  if (!type) throw new AppError("VALIDATION", "Format non accepté : PDF, PNG, JPEG ou WebP uniquement.");
  const sha256 = createHash("sha256").update(input.data).digest("hex");
  await storeFile(ctx.companyId, sha256, input.data);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(attachments)
      .values({
        companyId: ctx.companyId,
        entityType: input.entityType,
        entityId: input.entityId,
        fileName: sanitizeFileName(input.fileName, type.ext),
        mimeType: type.mime,
        size: input.data.length,
        sha256,
        createdBy: ctx.userId,
      })
      .returning();
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "attachment.added",
      entityType: input.entityType,
      entityId: input.entityId,
      payload: { attachment: row!.id, fileName: row!.fileName, size: row!.size, sha256 },
    });
    return row!;
  });
}

export async function listAttachments(db: Executor, ctx: CompanyContext, entityType: AttachmentEntity, entityId: string) {
  assertPermission(ctx, ENTITY_PERMISSIONS[entityType].read);
  const { locked } = await entityState(db, ctx, entityType, entityId);
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.companyId, ctx.companyId), eq(attachments.entityType, entityType), eq(attachments.entityId, entityId), isNull(attachments.removedAt)))
    .orderBy(asc(attachments.createdAt));
  return { rows, locked };
}

async function getRow(db: Executor, ctx: CompanyContext, id: string) {
  if (!isUuid(id)) throw notFound("Pièce jointe introuvable.");
  const [row] = await db.select().from(attachments).where(and(eq(attachments.companyId, ctx.companyId), eq(attachments.id, id), isNull(attachments.removedAt))).limit(1);
  if (!row) throw notFound("Pièce jointe introuvable.");
  return row;
}

/** Contenu d'une pièce, après contrôle des droits et de l'intégrité (empreinte). */
export async function readAttachment(db: Executor, ctx: CompanyContext, id: string) {
  const row = await getRow(db, ctx, id);
  assertPermission(ctx, ENTITY_PERMISSIONS[row.entityType].read);
  let data: Buffer;
  try {
    data = await readFile(filePath(row.companyId, row.sha256));
  } catch {
    throw new Error(`Pièce jointe ${row.id} : fichier absent du stockage (restaurer la sauvegarde des pièces jointes).`);
  }
  if (createHash("sha256").update(data).digest("hex") !== row.sha256) throw new Error(`Pièce jointe ${row.id} : fichier altéré dans le stockage (empreinte différente).`);
  return { row, data };
}

export async function removeAttachment(db: Db, ctx: CompanyContext, id: string) {
  return db.transaction(async (tx) => {
    const row = await getRow(tx, ctx, id);
    assertPermission(ctx, ENTITY_PERMISSIONS[row.entityType].write);
    const { locked } = await entityState(tx, ctx, row.entityType, row.entityId);
    if (locked) throw new AppError("VALIDATION", "Cette pièce justifie une opération validée : elle ne peut pas être retirée.");
    await tx.update(attachments).set({ removedAt: new Date(), removedBy: ctx.userId }).where(eq(attachments.id, row.id));
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "attachment.removed",
      entityType: row.entityType,
      entityId: row.entityId,
      payload: { attachment: row.id, fileName: row.fileName, sha256: row.sha256 },
    });
  });
}
