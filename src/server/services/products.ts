import { and, asc, desc, eq, ilike, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db, Executor, Tx } from "../db/client";
import { products, vatRates, type Product } from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { appendAuditEvent } from "./audit";
import { computeChanges, likePattern, PAGE_SIZE, type ListParams } from "./listing";
import { isUuid } from "./third-parties";
import { productSchema, UNITS, type ProductData } from "@/lib/schemas";
import { priceInclTax } from "../domain/document-totals";
import { csvToRecords, CSV_MAX_ROWS, CsvError, parseFrenchDecimal, toCsv, toFrenchDecimal } from "../domain/csv";
import { dec } from "../domain/money";

/**
 * Catalogue de produits et services. Les prix sont stockés HT (4 décimales) ;
 * le prix TTC est toujours recalculé à partir du taux de TVA, jamais stocké.
 * Pas de suppression : archivage (un article peut figurer sur des documents émis).
 */

export const PRODUCT_SORTS = ["reference", "nom", "prix", "creation"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export interface ProductFilters extends ListParams<ProductSort> {
  kind?: "good" | "service";
  category?: string;
}

const AUDITED_FIELDS = [
  "reference", "name", "description", "category", "kind", "unit", "unitPriceExclTax", "purchasePriceExclTax", "vatRateId", "barcode",
] as const;

function scoped(ctx: CompanyContext, id: string) {
  if (!isUuid(id)) throw notFound("Article introuvable.");
  return and(eq(products.companyId, ctx.companyId), eq(products.id, id));
}

/** Représentation canonique d'un prix (numeric(15,4)) : « 12.5 » → « 12.5000 ». */
const price = (v: string) => dec(v).toFixed(4);
const normalize = (d: ProductData) => ({
  ...d,
  unitPriceExclTax: price(d.unitPriceExclTax),
  purchasePriceExclTax: d.purchasePriceExclTax ? price(d.purchasePriceExclTax) : null,
});

export async function listProducts(db: Executor, ctx: CompanyContext, f: ProductFilters) {
  assertPermission(ctx, "catalog.read");
  const conditions: SQL[] = [eq(products.companyId, ctx.companyId)];
  conditions.push(f.archived ? isNotNull(products.archivedAt) : isNull(products.archivedAt));
  if (f.kind) conditions.push(eq(products.kind, f.kind));
  if (f.category) conditions.push(eq(products.category, f.category));
  if (f.q) {
    const p = likePattern(f.q);
    conditions.push(or(ilike(products.reference, p), ilike(products.name, p), ilike(products.barcode, p), ilike(products.category, p))!);
  }
  const where = and(...conditions);
  const column = {
    reference: sql`lower(${products.reference})`,
    nom: sql`lower(${products.name})`,
    prix: products.unitPriceExclTax,
    creation: products.createdAt,
  }[f.sort];

  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({ product: products, vatRate: vatRates.rate, vatLabel: vatRates.label })
      .from(products)
      .innerJoin(vatRates, and(eq(vatRates.id, products.vatRateId), eq(vatRates.companyId, products.companyId)))
      .where(where)
      .orderBy(f.dir === "desc" ? desc(column) : asc(column), asc(products.id))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(products).where(where),
  ]);
  return {
    rows: rows.map((r) => ({ ...r.product, vatRate: r.vatRate, vatLabel: r.vatLabel, priceInclTax: priceInclTax(r.product.unitPriceExclTax, r.vatRate) })),
    total,
    pageSize: PAGE_SIZE,
  };
}

export async function listCategories(db: Executor, ctx: CompanyContext): Promise<string[]> {
  assertPermission(ctx, "catalog.read");
  const rows = await db
    .selectDistinct({ category: products.category })
    .from(products)
    .where(and(eq(products.companyId, ctx.companyId), isNotNull(products.category)))
    .orderBy(asc(products.category));
  return rows.map((r) => r.category!).filter(Boolean);
}

export async function getProduct(db: Executor, ctx: CompanyContext, id: string): Promise<Product> {
  assertPermission(ctx, "catalog.read");
  const [row] = await db.select().from(products).where(scoped(ctx, id)).limit(1);
  if (!row) throw notFound("Article introuvable.");
  return row;
}

/** Le taux doit appartenir à l'entreprise (garanti aussi par clé composite en base) et être actif. */
async function assertVatRate(tx: Executor, ctx: CompanyContext, vatRateId: string) {
  const [rate] = await tx
    .select({ active: vatRates.active })
    .from(vatRates)
    .where(and(eq(vatRates.companyId, ctx.companyId), eq(vatRates.id, vatRateId)))
    .limit(1);
  if (!rate) throw new AppError("VALIDATION", "Taux de TVA inconnu.", { vatRateId: "Taux de TVA inconnu." });
  if (!rate.active) throw new AppError("VALIDATION", "Ce taux de TVA est désactivé.", { vatRateId: "Taux désactivé." });
}

async function assertReferenceAvailable(tx: Executor, companyId: string, reference: string, exceptId?: string) {
  const conditions = [eq(products.companyId, companyId), sql`lower(${products.reference}) = lower(${reference})`];
  if (exceptId) conditions.push(ne(products.id, exceptId));
  const [dup] = await tx.select({ id: products.id }).from(products).where(and(...conditions)).limit(1);
  if (dup) throw new AppError("CONFLICT", `La référence « ${reference} » existe déjà.`, { reference: "Référence déjà utilisée." });
}

async function insertProduct(tx: Tx, ctx: CompanyContext, data: ProductData, source: "form" | "import") {
  await assertVatRate(tx, ctx, data.vatRateId);
  await assertReferenceAvailable(tx, ctx.companyId, data.reference);
  const [row] = await tx.insert(products).values({ ...normalize(data), companyId: ctx.companyId }).returning();
  await appendAuditEvent(tx, {
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    action: "product.created",
    entityType: "product",
    entityId: row!.id,
    payload: { reference: row!.reference, name: row!.name, unitPriceExclTax: row!.unitPriceExclTax, source },
  });
  return row!;
}

export async function createProduct(db: Db, ctx: CompanyContext, raw: unknown) {
  assertPermission(ctx, "catalog.write");
  const data = productSchema.parse(raw);
  return db.transaction((tx) => insertProduct(tx, ctx, data, "form"));
}

export async function updateProduct(db: Db, ctx: CompanyContext, id: string, raw: unknown) {
  assertPermission(ctx, "catalog.write");
  const data = normalize(productSchema.parse(raw));
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(products).where(scoped(ctx, id)).for("update").limit(1);
    if (!before) throw notFound("Article introuvable.");
    if (data.vatRateId !== before.vatRateId) await assertVatRate(tx, ctx, data.vatRateId);
    if (data.reference.toLowerCase() !== before.reference.toLowerCase()) {
      await assertReferenceAvailable(tx, ctx.companyId, data.reference, id);
    }
    const changes = computeChanges(before, data, AUDITED_FIELDS);
    if (Object.keys(changes).length === 0) return before;
    const [after] = await tx.update(products).set({ ...data, updatedAt: new Date() }).where(scoped(ctx, id)).returning();
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "product.updated",
      entityType: "product",
      entityId: id,
      payload: { reference: after!.reference, changes },
    });
    return after!;
  });
}

export async function setProductArchived(db: Db, ctx: CompanyContext, id: string, archived: boolean) {
  assertPermission(ctx, "catalog.write");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(products)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(scoped(ctx, id), archived ? isNull(products.archivedAt) : isNotNull(products.archivedAt)))
      .returning({ id: products.id, reference: products.reference });
    if (!row) throw notFound("Article introuvable ou déjà dans cet état.");
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: archived ? "product.archived" : "product.restored",
      entityType: "product",
      entityId: id,
      payload: { reference: row.reference },
    });
  });
}

// ─── Import / export CSV ────────────────────────────────────────────────────

export const PRODUCT_CSV_HEADERS = [
  "reference", "designation", "description", "categorie", "nature", "unite", "prix_vente_ht", "prix_achat_ht", "taux_tva", "code_barres",
] as const;

const KIND_FROM_LABEL: Record<string, ProductData["kind"]> = {
  bien: "good",
  marchandise: "good",
  good: "good",
  service: "service",
  prestation: "service",
  prestation_de_services: "service",
};

export async function exportProductsCsv(db: Executor, ctx: CompanyContext): Promise<string> {
  assertPermission(ctx, "exports.run");
  const rows = await db
    .select({ p: products, rate: vatRates.rate })
    .from(products)
    .innerJoin(vatRates, and(eq(vatRates.id, products.vatRateId), eq(vatRates.companyId, products.companyId)))
    .where(and(eq(products.companyId, ctx.companyId), isNull(products.archivedAt)))
    .orderBy(asc(products.reference));
  return toCsv(
    PRODUCT_CSV_HEADERS,
    rows.map(({ p, rate }) => [
      p.reference,
      p.name,
      p.description,
      p.category,
      p.kind === "good" ? "bien" : "service",
      p.unit,
      toFrenchDecimal(p.unitPriceExclTax),
      toFrenchDecimal(p.purchasePriceExclTax),
      toFrenchDecimal(rate),
      p.barcode,
    ]),
  );
}

export async function importProductsCsv(db: Db, ctx: CompanyContext, content: string) {
  assertPermission(ctx, "catalog.write");
  let records: Record<string, string>[];
  try {
    ({ records } = csvToRecords(content));
  } catch (e) {
    if (e instanceof CsvError) throw new AppError("VALIDATION", e.message);
    throw e;
  }
  if (records.length === 0) throw new AppError("VALIDATION", "Aucune ligne à importer.");
  if (records.length > CSV_MAX_ROWS) throw new AppError("VALIDATION", `${CSV_MAX_ROWS} lignes au maximum par import.`);

  const rates = await db
    .select({ id: vatRates.id, rate: vatRates.rate })
    .from(vatRates)
    .where(and(eq(vatRates.companyId, ctx.companyId), eq(vatRates.active, true)));

  const errors: { line: number; message: string }[] = [];
  const valid: ProductData[] = [];
  const seen = new Set<string>();
  records.forEach((r, idx) => {
    const line = idx + 2;
    const rateText = parseFrenchDecimal(r.taux_tva ?? "");
    const matching = rateText === null ? [] : rates.filter((x) => dec(x.rate).equals(dec(rateText)));
    if (matching.length !== 1) {
      errors.push({
        line,
        message:
          matching.length === 0
            ? `taux_tva : « ${r.taux_tva ?? ""} » ne correspond à aucun taux actif de l'entreprise.`
            : `taux_tva : plusieurs taux à ${rateText} % (motifs d'exonération différents) ; choisissez-le dans l'application.`,
      });
      return;
    }
    const unit = UNITS.find((u) => u === (r.unite ?? "").trim().toLowerCase()) ?? r.unite;
    const parsed = productSchema.safeParse({
      reference: r.reference ?? "",
      name: r.designation ?? "",
      description: r.description ?? "",
      category: r.categorie ?? "",
      kind: KIND_FROM_LABEL[(r.nature ?? "").toLowerCase().replace(/\s+/g, "_")] ?? r.nature,
      unit,
      unitPriceExclTax: parseFrenchDecimal(r.prix_vente_ht ?? "") ?? r.prix_vente_ht ?? "",
      purchasePriceExclTax: parseFrenchDecimal(r.prix_achat_ht ?? "") ?? "",
      vatRateId: matching[0]!.id,
      barcode: r.code_barres ?? "",
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      errors.push({ line, message: `${issue.path.join(".") || "ligne"} : ${issue.message}` });
      return;
    }
    const key = parsed.data.reference.toLowerCase();
    if (seen.has(key)) {
      errors.push({ line, message: `reference : « ${parsed.data.reference} » apparaît plusieurs fois dans le fichier.` });
      return;
    }
    seen.add(key);
    valid.push(parsed.data);
  });
  if (errors.length > 0) return { imported: 0, errors };

  try {
    await db.transaction(async (tx) => {
      for (const [i, data] of valid.entries()) {
        try {
          await insertProduct(tx, ctx, data, "import");
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
