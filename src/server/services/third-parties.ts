import { and, asc, desc, eq, ilike, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db, Executor, Tx } from "../db/client";
import { contacts, thirdParties, type ThirdParty } from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { appendAuditEvent } from "./audit";
import { allocateCounter } from "./sequences";
import { computeChanges, likePattern, PAGE_SIZE, type ListParams } from "./listing";
import { contactSchema, PARTY_TYPE_LABELS, thirdPartySchema, type ThirdPartyData } from "@/lib/schemas";
import { csvToRecords, CSV_MAX_ROWS, CsvError, toCsv } from "../domain/csv";

/**
 * Tiers : clients et fournisseurs.
 * Pas de suppression : un tiers est archivé (il peut être référencé par des documents
 * comptables ou commerciaux qui doivent rester consultables).
 */

export const THIRD_PARTY_SORTS = ["nom", "code", "creation"] as const;
export type ThirdPartySort = (typeof THIRD_PARTY_SORTS)[number];

export interface ThirdPartyFilters extends ListParams<ThirdPartySort> {
  role?: "clients" | "fournisseurs";
  type?: "individual" | "business" | "public_entity";
}

const AUDITED_FIELDS = [
  "code", "isCustomer", "isSupplier", "partyType", "name", "legalForm", "siren", "siret", "vatNumber", "email", "phone",
  "billingLine1", "billingLine2", "billingPostalCode", "billingCity", "billingCountry", "shippingLine1", "shippingLine2",
  "shippingPostalCode", "shippingCity", "shippingCountry", "paymentTermsDays", "notes",
] as const;

function scoped(ctx: CompanyContext, id: string) {
  if (!isUuid(id)) throw notFound("Tiers introuvable.");
  return and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.id, id));
}

export async function listThirdParties(db: Executor, ctx: CompanyContext, f: ThirdPartyFilters) {
  assertPermission(ctx, "thirdparties.read");
  const conditions: SQL[] = [eq(thirdParties.companyId, ctx.companyId)];
  conditions.push(f.archived ? isNotNull(thirdParties.archivedAt) : isNull(thirdParties.archivedAt));
  if (f.role === "clients") conditions.push(eq(thirdParties.isCustomer, true));
  if (f.role === "fournisseurs") conditions.push(eq(thirdParties.isSupplier, true));
  if (f.type) conditions.push(eq(thirdParties.partyType, f.type));
  if (f.q) {
    const p = likePattern(f.q);
    conditions.push(
      or(
        ilike(thirdParties.name, p),
        ilike(thirdParties.code, p),
        ilike(thirdParties.email, p),
        ilike(thirdParties.siren, p),
        ilike(thirdParties.billingCity, p),
      )!,
    );
  }
  const where = and(...conditions);
  const column = { nom: sql`lower(${thirdParties.name})`, code: thirdParties.code, creation: thirdParties.createdAt }[f.sort];
  const order = f.dir === "desc" ? desc(column) : asc(column);

  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select()
      .from(thirdParties)
      .where(where)
      .orderBy(order, asc(thirdParties.id))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(thirdParties).where(where),
  ]);
  return { rows, total, pageSize: PAGE_SIZE };
}

export async function getThirdParty(db: Executor, ctx: CompanyContext, id: string): Promise<ThirdParty> {
  assertPermission(ctx, "thirdparties.read");
  const [row] = await db.select().from(thirdParties).where(scoped(ctx, id)).limit(1);
  if (!row) throw notFound("Tiers introuvable.");
  return row;
}

async function assertCodeAvailable(tx: Executor, companyId: string, code: string, exceptId?: string) {
  const conditions = [eq(thirdParties.companyId, companyId), eq(thirdParties.code, code)];
  if (exceptId) conditions.push(ne(thirdParties.id, exceptId));
  const [dup] = await tx.select({ id: thirdParties.id }).from(thirdParties).where(and(...conditions)).limit(1);
  if (dup) throw new AppError("CONFLICT", `Le code « ${code} » est déjà utilisé.`, { code: "Code déjà utilisé." });
}

async function nextCode(tx: Tx, companyId: string, data: ThirdPartyData): Promise<string> {
  const [key, prefix] = data.isCustomer ? ["third_party_customer", "C"] : ["third_party_supplier", "F"];
  // Boucle : un code saisi manuellement peut déjà occuper la valeur suivante du compteur.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const code = `${prefix}${String(await allocateCounter(tx, companyId, key)).padStart(5, "0")}`;
    const [dup] = await tx
      .select({ id: thirdParties.id })
      .from(thirdParties)
      .where(and(eq(thirdParties.companyId, companyId), eq(thirdParties.code, code)))
      .limit(1);
    if (!dup) return code;
  }
  throw new Error("Impossible d'attribuer un code de tiers.");
}

/** Colonnes à enregistrer (le drapeau de formulaire hasShippingAddress n'est pas une colonne). */
function toColumns(data: ThirdPartyData) {
  const { hasShippingAddress, ...columns } = data;
  void hasShippingAddress;
  return columns;
}

async function insertThirdParty(tx: Tx, ctx: CompanyContext, data: ThirdPartyData, source: "form" | "import") {
  const code = data.code ?? (await nextCode(tx, ctx.companyId, data));
  if (data.code) await assertCodeAvailable(tx, ctx.companyId, code);
  const [row] = await tx
    .insert(thirdParties)
    .values({ ...toColumns(data), code, companyId: ctx.companyId })
    .returning();
  await appendAuditEvent(tx, {
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    action: "third_party.created",
    entityType: "third_party",
    entityId: row!.id,
    payload: { code, name: row!.name, partyType: row!.partyType, source },
  });
  return row!;
}

export async function createThirdParty(db: Db, ctx: CompanyContext, raw: unknown) {
  assertPermission(ctx, "thirdparties.write");
  const data = thirdPartySchema.parse(raw);
  return db.transaction((tx) => insertThirdParty(tx, ctx, data, "form"));
}

export async function updateThirdParty(db: Db, ctx: CompanyContext, id: string, raw: unknown) {
  assertPermission(ctx, "thirdparties.write");
  const data = thirdPartySchema.parse(raw);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(thirdParties).where(scoped(ctx, id)).for("update").limit(1);
    if (!before) throw notFound("Tiers introuvable.");
    const code = data.code ?? before.code;
    if (code !== before.code) await assertCodeAvailable(tx, ctx.companyId, code, id);
    const next = { ...toColumns(data), code };
    const changes = computeChanges(before, next, AUDITED_FIELDS);
    if (Object.keys(changes).length === 0) return before;
    const [after] = await tx
      .update(thirdParties)
      .set({ ...next, updatedAt: new Date() })
      .where(scoped(ctx, id))
      .returning();
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "third_party.updated",
      entityType: "third_party",
      entityId: id,
      payload: { code, changes },
    });
    return after!;
  });
}

export async function setThirdPartyArchived(db: Db, ctx: CompanyContext, id: string, archived: boolean) {
  assertPermission(ctx, "thirdparties.write");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(thirdParties)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(scoped(ctx, id), archived ? isNull(thirdParties.archivedAt) : isNotNull(thirdParties.archivedAt)))
      .returning({ id: thirdParties.id, code: thirdParties.code });
    if (!row) throw notFound("Tiers introuvable ou déjà dans cet état.");
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: archived ? "third_party.archived" : "third_party.restored",
      entityType: "third_party",
      entityId: id,
      payload: { code: row.code },
    });
  });
}

// ─── Contacts ───────────────────────────────────────────────────────────────

export async function listContacts(db: Executor, ctx: CompanyContext, thirdPartyId: string) {
  assertPermission(ctx, "thirdparties.read");
  if (!isUuid(thirdPartyId)) return [];
  return db
    .select()
    .from(contacts)
    .where(and(eq(contacts.companyId, ctx.companyId), eq(contacts.thirdPartyId, thirdPartyId)))
    .orderBy(desc(contacts.isPrimary), asc(contacts.fullName));
}

export async function addContact(db: Db, ctx: CompanyContext, thirdPartyId: string, raw: unknown) {
  assertPermission(ctx, "thirdparties.write");
  const data = contactSchema.parse(raw);
  return db.transaction(async (tx) => {
    const party = await getThirdParty(tx, ctx, thirdPartyId);
    if (data.isPrimary) {
      await tx
        .update(contacts)
        .set({ isPrimary: false })
        .where(and(eq(contacts.companyId, ctx.companyId), eq(contacts.thirdPartyId, party.id)));
    }
    const [row] = await tx.insert(contacts).values({ ...data, companyId: ctx.companyId, thirdPartyId: party.id }).returning();
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "contact.added",
      entityType: "third_party",
      entityId: party.id,
      payload: { contactId: row!.id, fullName: row!.fullName },
    });
    return row!;
  });
}

export async function removeContact(db: Db, ctx: CompanyContext, contactId: string) {
  assertPermission(ctx, "thirdparties.write");
  if (!isUuid(contactId)) throw notFound("Contact introuvable.");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(contacts)
      .where(and(eq(contacts.companyId, ctx.companyId), eq(contacts.id, contactId)))
      .returning();
    if (!row) throw notFound("Contact introuvable.");
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "contact.removed",
      entityType: "third_party",
      entityId: row.thirdPartyId,
      payload: { contactId: row.id, fullName: row.fullName },
    });
  });
}

// ─── Import / export CSV ────────────────────────────────────────────────────

export const THIRD_PARTY_CSV_HEADERS = [
  "code", "type", "client", "fournisseur", "nom", "forme_juridique", "siren", "siret", "tva", "email", "telephone",
  "adresse", "complement_adresse", "code_postal", "ville", "pays", "livraison_adresse", "livraison_complement",
  "livraison_code_postal", "livraison_ville", "livraison_pays", "delai_paiement", "notes",
] as const;

const TYPE_FROM_LABEL: Record<string, ThirdPartyData["partyType"]> = {
  particulier: "individual",
  individual: "individual",
  professionnel: "business",
  entreprise: "business",
  business: "business",
  organisme_public: "public_entity",
  public: "public_entity",
  public_entity: "public_entity",
};

const yes = (v: string | undefined) => ["oui", "o", "1", "x", "true", "vrai", "yes"].includes((v ?? "").trim().toLowerCase());

/** Export CSV des tiers actifs, éventuellement limité aux clients ou aux fournisseurs. */
export async function exportThirdPartiesCsv(db: Executor, ctx: CompanyContext, role?: "clients" | "fournisseurs"): Promise<string> {
  assertPermission(ctx, "exports.run");
  const rows = await db
    .select()
    .from(thirdParties)
    .where(
      and(
        eq(thirdParties.companyId, ctx.companyId),
        isNull(thirdParties.archivedAt),
        role === "clients" ? eq(thirdParties.isCustomer, true) : role === "fournisseurs" ? eq(thirdParties.isSupplier, true) : undefined,
      ),
    )
    .orderBy(asc(thirdParties.code));
  return toCsv(
    THIRD_PARTY_CSV_HEADERS,
    rows.map((r) => [
      r.code, PARTY_TYPE_LABELS[r.partyType], r.isCustomer ? "oui" : "non", r.isSupplier ? "oui" : "non", r.name, r.legalForm,
      r.siren, r.siret, r.vatNumber, r.email, r.phone, r.billingLine1, r.billingLine2, r.billingPostalCode, r.billingCity,
      r.billingCountry, r.shippingLine1, r.shippingLine2, r.shippingPostalCode, r.shippingCity, r.shippingCountry,
      r.paymentTermsDays, r.notes,
    ]),
  );
}

export interface ImportReport {
  imported: number;
  errors: { line: number; message: string }[];
}

/**
 * Import contrôlé : toutes les lignes sont validées ; s'il existe la moindre erreur,
 * RIEN n'est importé (transaction unique) et le rapport détaille chaque ligne fautive.
 */
export async function importThirdPartiesCsv(db: Db, ctx: CompanyContext, content: string): Promise<ImportReport> {
  assertPermission(ctx, "thirdparties.write");
  let records: Record<string, string>[];
  try {
    ({ records } = csvToRecords(content));
  } catch (e) {
    if (e instanceof CsvError) throw new AppError("VALIDATION", e.message);
    throw e;
  }
  if (records.length === 0) throw new AppError("VALIDATION", "Aucune ligne à importer.");
  if (records.length > CSV_MAX_ROWS) throw new AppError("VALIDATION", `${CSV_MAX_ROWS} lignes au maximum par import.`);

  const errors: ImportReport["errors"] = [];
  const valid: ThirdPartyData[] = [];
  const seenCodes = new Set<string>();
  records.forEach((r, idx) => {
    const line = idx + 2; // ligne 1 = en-tête
    const hasShipping = !!(r.livraison_adresse || r.livraison_code_postal || r.livraison_ville);
    const parsed = thirdPartySchema.safeParse({
      code: r.code ?? "",
      partyType: TYPE_FROM_LABEL[(r.type ?? "").toLowerCase().replace(/\s+/g, "_")] ?? r.type,
      isCustomer: r.client === undefined ? true : yes(r.client),
      isSupplier: yes(r.fournisseur),
      name: r.nom ?? "",
      legalForm: r.forme_juridique ?? "",
      siren: r.siren ?? "",
      siret: r.siret ?? "",
      vatNumber: r.tva ?? "",
      email: r.email ?? "",
      phone: r.telephone ?? "",
      billingLine1: r.adresse ?? "",
      billingLine2: r.complement_adresse ?? "",
      billingPostalCode: r.code_postal ?? "",
      billingCity: r.ville ?? "",
      billingCountry: r.pays || "FR",
      hasShippingAddress: hasShipping,
      shippingLine1: r.livraison_adresse ?? "",
      shippingLine2: r.livraison_complement ?? "",
      shippingPostalCode: r.livraison_code_postal ?? "",
      shippingCity: r.livraison_ville ?? "",
      shippingCountry: r.livraison_pays ?? "",
      paymentTermsDays: r.delai_paiement ?? "",
      notes: r.notes ?? "",
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const field = issue.path.join(".");
      errors.push({ line, message: `${field ? field + " : " : ""}${issue.message}` });
      return;
    }
    if (parsed.data.code) {
      if (seenCodes.has(parsed.data.code)) {
        errors.push({ line, message: `code : « ${parsed.data.code} » apparaît plusieurs fois dans le fichier.` });
        return;
      }
      seenCodes.add(parsed.data.code);
    }
    valid.push(parsed.data);
  });
  if (errors.length > 0) return { imported: 0, errors };

  try {
    await db.transaction(async (tx) => {
      for (const [i, data] of valid.entries()) {
        try {
          await insertThirdParty(tx, ctx, data, "import");
        } catch (e) {
          if (e instanceof AppError) throw new AppError(e.code, `Ligne ${i + 2} : ${e.message}`);
          throw e;
        }
      }
    });
  } catch (e) {
    if (e instanceof AppError) return { imported: 0, errors: [{ line: 0, message: e.message }] };
    throw e;
  }
  return { imported: valid.length, errors: [] };
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
