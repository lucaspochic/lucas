import { and, asc, desc, eq, ilike, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db, Executor, Tx } from "../db/client";
import { auditEvents, equipment, salesDocuments, thirdParties, users } from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { appendAuditEvent } from "./audit";
import { computeChanges, likePattern, PAGE_SIZE, type ListParams } from "./listing";
import { isUuid } from "./third-parties";
import { equipmentSchema, EQUIPMENT_CATEGORIES, type EquipmentData } from "@/lib/schemas";

/**
 * Parc matériel : matériels détenus par les clients (véhicules, tracteurs, engins…).
 * Le parc fait partie de la fiche client : mêmes droits que les tiers.
 * Pas de suppression : archivage. Un changement de propriétaire (revente, reprise)
 * est tracé dans le journal d'audit, ce qui donne l'historique des détenteurs.
 */

export const EQUIPMENT_SORTS = ["client", "marque", "vente", "creation"] as const;
export type EquipmentSort = (typeof EQUIPMENT_SORTS)[number];

export interface EquipmentFilters extends ListParams<EquipmentSort> {
  category?: (typeof EQUIPMENT_CATEGORIES)[number];
}

const AUDITED_FIELDS = [
  "thirdPartyId", "category", "brand", "model", "serialNumber", "registration", "year", "meterValue", "meterUnit",
  "soldOn", "salesDocumentId", "warrantyEndsOn", "notes",
] as const;

function scoped(ctx: CompanyContext, id: string) {
  if (!isUuid(id)) throw notFound("Matériel introuvable.");
  return and(eq(equipment.companyId, ctx.companyId), eq(equipment.id, id));
}

const listColumns = {
  id: equipment.id,
  category: equipment.category,
  brand: equipment.brand,
  model: equipment.model,
  serialNumber: equipment.serialNumber,
  registration: equipment.registration,
  year: equipment.year,
  meterValue: equipment.meterValue,
  meterUnit: equipment.meterUnit,
  soldOn: equipment.soldOn,
  warrantyEndsOn: equipment.warrantyEndsOn,
  archivedAt: equipment.archivedAt,
  thirdPartyId: equipment.thirdPartyId,
  partyName: thirdParties.name,
  partyCode: thirdParties.code,
};

export async function listEquipment(db: Executor, ctx: CompanyContext, f: EquipmentFilters) {
  assertPermission(ctx, "thirdparties.read");
  const conditions: SQL[] = [eq(equipment.companyId, ctx.companyId)];
  conditions.push(f.archived ? isNotNull(equipment.archivedAt) : isNull(equipment.archivedAt));
  if (f.category) conditions.push(eq(equipment.category, f.category));
  if (f.q) {
    const p = likePattern(f.q);
    // L'immatriculation est cherchée aussi sans tirets ni espaces (« AB123CD » trouve « AB-123-CD »).
    const compact = likePattern(f.q.toUpperCase().replace(/[\s-]/g, ""));
    conditions.push(
      or(
        ilike(equipment.brand, p),
        ilike(equipment.model, p),
        ilike(equipment.serialNumber, p),
        ilike(equipment.registration, p),
        sql`replace(${equipment.registration}, '-', '') like ${compact}`,
        ilike(thirdParties.name, p),
        ilike(thirdParties.code, p),
      )!,
    );
  }
  const where = and(...conditions);
  const column = {
    client: sql`lower(${thirdParties.name})`,
    marque: sql`lower(${equipment.brand} || ' ' || ${equipment.model})`,
    vente: equipment.soldOn,
    creation: equipment.createdAt,
  }[f.sort];
  const order = f.dir === "desc" ? sql`${column} desc nulls last` : sql`${column} asc nulls last`;
  const join = and(eq(thirdParties.id, equipment.thirdPartyId), eq(thirdParties.companyId, equipment.companyId));

  const rows = await db
    .select(listColumns)
    .from(equipment)
    .innerJoin(thirdParties, join)
    .where(where)
    .orderBy(order, asc(equipment.id))
    .limit(PAGE_SIZE)
    .offset((f.page - 1) * PAGE_SIZE);
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(equipment)
    .innerJoin(thirdParties, join)
    .where(where);
  return { rows, total, pageSize: PAGE_SIZE };
}

/** Matériels d'un client (fiche tiers), actifs d'abord. */
export async function listEquipmentOfParty(db: Executor, ctx: CompanyContext, thirdPartyId: string) {
  assertPermission(ctx, "thirdparties.read");
  if (!isUuid(thirdPartyId)) return [];
  return db
    .select({
      id: equipment.id,
      category: equipment.category,
      brand: equipment.brand,
      model: equipment.model,
      serialNumber: equipment.serialNumber,
      registration: equipment.registration,
      year: equipment.year,
      soldOn: equipment.soldOn,
      warrantyEndsOn: equipment.warrantyEndsOn,
      archivedAt: equipment.archivedAt,
    })
    .from(equipment)
    .where(and(eq(equipment.companyId, ctx.companyId), eq(equipment.thirdPartyId, thirdPartyId)))
    .orderBy(sql`${equipment.archivedAt} is not null`, desc(equipment.soldOn), asc(equipment.brand));
}

/** Matériels rattachés à une facture de vente. */
export async function listEquipmentOfDocument(db: Executor, ctx: CompanyContext, documentId: string) {
  assertPermission(ctx, "thirdparties.read");
  if (!isUuid(documentId)) return [];
  return db
    .select({ id: equipment.id, brand: equipment.brand, model: equipment.model, serialNumber: equipment.serialNumber, registration: equipment.registration })
    .from(equipment)
    .where(and(eq(equipment.companyId, ctx.companyId), eq(equipment.salesDocumentId, documentId)))
    .orderBy(asc(equipment.brand), asc(equipment.model));
}

export async function getEquipment(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "thirdparties.read");
  const [row] = await db
    .select({
      item: equipment,
      partyName: thirdParties.name,
      partyCode: thirdParties.code,
      invoiceNumber: salesDocuments.number,
      invoiceDate: salesDocuments.issueDate,
    })
    .from(equipment)
    .innerJoin(thirdParties, and(eq(thirdParties.id, equipment.thirdPartyId), eq(thirdParties.companyId, equipment.companyId)))
    .leftJoin(salesDocuments, and(eq(salesDocuments.id, equipment.salesDocumentId), eq(salesDocuments.companyId, equipment.companyId)))
    .where(scoped(ctx, id))
    .limit(1);
  if (!row) throw notFound("Matériel introuvable.");
  return row;
}

/** Factures émises au client, proposées pour rattacher un matériel à sa vente. */
export async function invoicesOfParty(db: Executor, ctx: CompanyContext, thirdPartyId: string) {
  assertPermission(ctx, "thirdparties.read");
  if (!isUuid(thirdPartyId)) return [];
  return db
    .select({ id: salesDocuments.id, number: salesDocuments.number, issueDate: salesDocuments.issueDate, totalInclTax: salesDocuments.totalInclTax })
    .from(salesDocuments)
    .where(
      and(
        eq(salesDocuments.companyId, ctx.companyId),
        eq(salesDocuments.thirdPartyId, thirdPartyId),
        eq(salesDocuments.type, "invoice"),
        ne(salesDocuments.status, "draft"),
      ),
    )
    .orderBy(desc(salesDocuments.issueDate), desc(salesDocuments.number))
    .limit(200);
}

/** Clients actifs proposés comme propriétaires (le propriétaire actuel reste proposé même archivé). */
export async function customerOptions(db: Executor, ctx: CompanyContext, includeId?: string) {
  assertPermission(ctx, "thirdparties.read");
  const active = and(eq(thirdParties.isCustomer, true), isNull(thirdParties.archivedAt));
  return db
    .select({ id: thirdParties.id, code: thirdParties.code, name: thirdParties.name })
    .from(thirdParties)
    .where(and(eq(thirdParties.companyId, ctx.companyId), includeId && isUuid(includeId) ? or(active, eq(thirdParties.id, includeId)) : active))
    .orderBy(asc(sql`lower(${thirdParties.name})`))
    .limit(1000);
}

/** Indicateurs du tableau de bord : matériels en service et garanties échues dans les 60 jours. */
export async function parcSummary(db: Executor, ctx: CompanyContext, today: string) {
  assertPermission(ctx, "thirdparties.read");
  const [row] = await db
    .select({
      active: sql<number>`count(*)::int`,
      warrantySoon: sql<number>`count(*) filter (where ${equipment.warrantyEndsOn} between ${today} and to_char(${today}::date + 60, 'YYYY-MM-DD'))::int`,
    })
    .from(equipment)
    .where(and(eq(equipment.companyId, ctx.companyId), isNull(equipment.archivedAt)));
  return { active: row?.active ?? 0, warrantySoon: row?.warrantySoon ?? 0 };
}

/** Le parc contient-il au moins un matériel ? (le module reste alors visible dans la navigation) */
export async function hasEquipment(db: Executor, companyId: string): Promise<boolean> {
  const [row] = await db.select({ id: equipment.id }).from(equipment).where(eq(equipment.companyId, companyId)).limit(1);
  return !!row;
}

/** Historique tracé (création, modifications, changements de propriétaire, archivage). */
export async function equipmentHistory(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "thirdparties.read");
  if (!isUuid(id)) return [];
  return db
    .select({ action: auditEvents.action, occurredAt: auditEvents.occurredAt, payload: auditEvents.payload, actor: users.fullName })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(and(eq(auditEvents.companyId, ctx.companyId), eq(auditEvents.entityType, "equipment"), eq(auditEvents.entityId, id)))
    .orderBy(desc(auditEvents.chainSeq))
    .limit(100);
}

/** Contrôles de cohérence : client de l'entreprise, facture émise à ce client, n° de série unique. */
async function checkReferences(tx: Tx, ctx: CompanyContext, data: EquipmentData, opts: { exceptId?: string; ownerChanged: boolean }) {
  const [party] = await tx
    .select({ id: thirdParties.id, name: thirdParties.name, isCustomer: thirdParties.isCustomer, archivedAt: thirdParties.archivedAt })
    .from(thirdParties)
    .where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.id, data.thirdPartyId)))
    .limit(1);
  if (!party) throw new AppError("VALIDATION", "Client introuvable.", { thirdPartyId: "Client introuvable." });
  if (opts.ownerChanged && (!party.isCustomer || party.archivedAt)) {
    throw new AppError("VALIDATION", "Choisissez un client actif.", { thirdPartyId: "Choisissez un client actif." });
  }
  if (data.salesDocumentId) {
    const [doc] = await tx
      .select({ thirdPartyId: salesDocuments.thirdPartyId, type: salesDocuments.type, status: salesDocuments.status })
      .from(salesDocuments)
      .where(and(eq(salesDocuments.companyId, ctx.companyId), eq(salesDocuments.id, data.salesDocumentId)))
      .limit(1);
    if (!doc || doc.type !== "invoice" || doc.status === "draft") {
      throw new AppError("VALIDATION", "La pièce de vente doit être une facture émise.", { salesDocumentId: "Facture émise requise." });
    }
    if (doc.thirdPartyId !== data.thirdPartyId) {
      throw new AppError("VALIDATION", "La facture choisie n'est pas adressée à ce client.", { salesDocumentId: "Facture d'un autre client." });
    }
  }
  if (data.serialNumber) {
    const conditions = [eq(equipment.companyId, ctx.companyId), sql`upper(${equipment.serialNumber}) = ${data.serialNumber.toUpperCase()}`];
    if (opts.exceptId) conditions.push(ne(equipment.id, opts.exceptId));
    const [dup] = await tx.select({ id: equipment.id }).from(equipment).where(and(...conditions)).limit(1);
    if (dup) throw new AppError("CONFLICT", "Ce numéro de série est déjà enregistré dans le parc.", { serialNumber: "Numéro déjà enregistré." });
  }
  return party;
}

function toColumns(data: EquipmentData) {
  return {
    thirdPartyId: data.thirdPartyId,
    category: data.category,
    brand: data.brand,
    model: data.model,
    serialNumber: data.serialNumber ?? null,
    registration: data.registration ?? null,
    year: data.year ?? null,
    meterValue: data.meterValue ?? null,
    meterUnit: (data.meterValue ?? null) === null ? null : (data.meterUnit ?? null),
    soldOn: data.soldOn ?? null,
    salesDocumentId: data.salesDocumentId ?? null,
    warrantyEndsOn: data.warrantyEndsOn ?? null,
    notes: data.notes ?? null,
  };
}

export async function createEquipment(db: Db, ctx: CompanyContext, raw: unknown) {
  assertPermission(ctx, "thirdparties.write");
  const data = equipmentSchema.parse(raw);
  return db.transaction(async (tx) => {
    const party = await checkReferences(tx, ctx, data, { ownerChanged: true });
    const [row] = await tx
      .insert(equipment)
      .values({ ...toColumns(data), companyId: ctx.companyId })
      .returning();
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "equipment.created",
      entityType: "equipment",
      entityId: row!.id,
      payload: { brand: row!.brand, model: row!.model, serialNumber: row!.serialNumber, owner: { id: party.id, name: party.name } },
    });
    return row!;
  });
}

export async function updateEquipment(db: Db, ctx: CompanyContext, id: string, raw: unknown) {
  assertPermission(ctx, "thirdparties.write");
  const data = equipmentSchema.parse(raw);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(equipment).where(scoped(ctx, id)).for("update").limit(1);
    if (!before) throw notFound("Matériel introuvable.");
    if (before.archivedAt) throw new AppError("VALIDATION", "Matériel archivé : restaurez-le avant de le modifier.");
    const ownerChanged = before.thirdPartyId !== data.thirdPartyId;
    const party = await checkReferences(tx, ctx, data, { exceptId: id, ownerChanged });
    const next = toColumns(data);
    const changes = computeChanges(before, next, AUDITED_FIELDS);
    if (Object.keys(changes).length === 0) return before;
    const [after] = await tx
      .update(equipment)
      .set({ ...next, updatedAt: new Date() })
      .where(scoped(ctx, id))
      .returning();
    let previousOwner: { id: string; name: string } | null = null;
    if (ownerChanged) {
      const [prev] = await tx.select({ id: thirdParties.id, name: thirdParties.name }).from(thirdParties)
        .where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.id, before.thirdPartyId))).limit(1);
      previousOwner = prev ?? null;
    }
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: ownerChanged ? "equipment.owner_changed" : "equipment.updated",
      entityType: "equipment",
      entityId: id,
      payload: ownerChanged ? { changes, from: previousOwner, to: { id: party.id, name: party.name } } : { changes },
    });
    return after!;
  });
}

export async function setEquipmentArchived(db: Db, ctx: CompanyContext, id: string, archived: boolean) {
  assertPermission(ctx, "thirdparties.write");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(equipment)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(scoped(ctx, id), archived ? isNull(equipment.archivedAt) : isNotNull(equipment.archivedAt)))
      .returning({ id: equipment.id, brand: equipment.brand, model: equipment.model });
    if (!row) throw notFound("Matériel introuvable ou déjà dans cet état.");
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: archived ? "equipment.archived" : "equipment.restored",
      entityType: "equipment",
      entityId: id,
      payload: { brand: row.brand, model: row.model },
    });
  });
}
