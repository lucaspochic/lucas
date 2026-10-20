import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { auditEvents, users } from "../db/schema";
import type { Executor } from "../db/client";
import { canonicalJson } from "../security/canonical-json";
import { assertPermission, type CompanyContext } from "../security/permissions";

/**
 * Journal d'audit append-only chaîné.
 *
 * Chaque événement porte l'empreinte SHA-256 de son contenu canonique concaténé à
 * l'empreinte de l'événement précédent de la même chaîne (une chaîne par entreprise,
 * plus une chaîne « système » pour les événements hors entreprise).
 * Toute modification, suppression ou insertion a posteriori rompt la chaîne et est
 * détectée par verifyAuditChain().
 *
 * Protection en base : triggers interdisant UPDATE / DELETE / TRUNCATE (migration 0001).
 * Limite : un administrateur de la base peut désactiver un trigger ; la chaîne permet
 * alors de DÉTECTER l'altération, pas de l'empêcher. Voir docs/06-conformite-caisse.md.
 */

export const GENESIS_HASH = "0".repeat(64);

export interface AuditInput {
  companyId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

interface HashableEvent {
  companyId: string | null;
  chainSeq: number;
  occurredAt: Date;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  payload: unknown;
}

export function computeEventHash(prevHash: string, e: HashableEvent): string {
  const body = canonicalJson({
    action: e.action,
    actorUserId: e.actorUserId,
    chainSeq: e.chainSeq,
    companyId: e.companyId,
    entityId: e.entityId,
    entityType: e.entityType,
    occurredAt: e.occurredAt.toISOString(),
    payload: e.payload,
  });
  return createHash("sha256").update(prevHash).update("\n").update(body).digest("hex");
}

const chainFilter = (companyId: string | null) =>
  companyId === null ? isNull(auditEvents.companyId) : eq(auditEvents.companyId, companyId);

/**
 * Ajoute un événement. DOIT être appelé dans la transaction de l'opération métier
 * auditée : si l'opération échoue, l'événement n'existe pas, et inversement.
 */
export async function appendAuditEvent(tx: Executor, input: AuditInput) {
  // Verrou transactionnel sur la tête de chaîne : sérialise les ajouts concurrents.
  const lockKey = input.companyId ?? "system";
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"audit:" + lockKey}))`);

  const [last] = await tx
    .select({ chainSeq: auditEvents.chainSeq, hash: auditEvents.hash })
    .from(auditEvents)
    .where(chainFilter(input.companyId))
    .orderBy(desc(auditEvents.chainSeq))
    .limit(1);

  // Date JS (précision milliseconde) : identique après aller-retour par timestamptz.
  const occurredAt = new Date();
  const event: HashableEvent = {
    companyId: input.companyId,
    chainSeq: (last?.chainSeq ?? 0) + 1,
    occurredAt,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    payload: JSON.parse(canonicalJson(input.payload ?? {})),
  };
  const prevHash = last?.hash ?? GENESIS_HASH;
  const hash = computeEventHash(prevHash, event);

  const [row] = await tx
    .insert(auditEvents)
    .values({ ...event, payload: event.payload as Record<string, unknown>, prevHash, hash })
    .returning();
  return row!;
}

export interface ChainVerification {
  valid: boolean;
  eventsChecked: number;
  headHash: string;
  firstError?: { chainSeq: number; reason: string };
}

/** Recalcule toute la chaîne d'une entreprise (ou la chaîne système si companyId = null). */
export async function verifyAuditChain(db: Executor, companyId: string | null): Promise<ChainVerification> {
  const rows = await db.select().from(auditEvents).where(chainFilter(companyId)).orderBy(asc(auditEvents.chainSeq));
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of rows) {
    const fail = (reason: string): ChainVerification => ({
      valid: false,
      eventsChecked: expectedSeq - 1,
      headHash: prevHash,
      firstError: { chainSeq: row.chainSeq, reason },
    });
    if (row.chainSeq !== expectedSeq) return fail(`Rupture de séquence : attendu ${expectedSeq}, trouvé ${row.chainSeq}.`);
    if (row.prevHash !== prevHash) return fail("Empreinte précédente incohérente (événement supprimé ou inséré).");
    const recomputed = computeEventHash(prevHash, {
      companyId: row.companyId,
      chainSeq: row.chainSeq,
      occurredAt: row.occurredAt,
      actorUserId: row.actorUserId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      payload: row.payload,
    });
    if (recomputed !== row.hash) return fail("Empreinte invalide : le contenu de l'événement a été modifié.");
    prevHash = row.hash;
    expectedSeq++;
  }
  return { valid: true, eventsChecked: rows.length, headHash: prevHash };
}

export async function listAuditEvents(db: Executor, ctx: CompanyContext, opts: { limit?: number; offset?: number } = {}) {
  assertPermission(ctx, "audit.read");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return db
    .select({
      id: auditEvents.id,
      chainSeq: auditEvents.chainSeq,
      occurredAt: auditEvents.occurredAt,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      payload: auditEvents.payload,
      hash: auditEvents.hash,
      actorName: users.fullName,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(and(eq(auditEvents.companyId, ctx.companyId)))
    .orderBy(desc(auditEvents.chainSeq))
    .limit(limit)
    .offset(opts.offset ?? 0);
}

export async function verifyCompanyAuditChain(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "audit.verify");
  return verifyAuditChain(db, ctx.companyId);
}
