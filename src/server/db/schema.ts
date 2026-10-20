import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Schéma de données — source de vérité.
 * Conventions :
 *  - identifiants UUID v4 générés par la base ;
 *  - montants en numeric(15,2), prix unitaires numeric(15,4), taux numeric(5,2) ;
 *  - horodatages en timestamptz (UTC) ;
 *  - toute table métier porte company_id (isolation multi-entreprises).
 * Les triggers d'inaltérabilité sont définis dans les migrations SQL (drizzle/).
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const roleEnum = pgEnum("member_role", ["owner", "admin", "accountant", "sales", "cashier", "viewer"]);
export const vatRegimeEnum = pgEnum("vat_regime", ["reel_normal", "reel_simplifie", "franchise_en_base", "mini_reel"]);

// ─── Utilisateurs et sessions ────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    fullName: text("full_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 du jeton : le jeton en clair n'est jamais stocké. */
    tokenHash: text("token_hash").notNull(),
    activeCompanyId: uuid("active_company_id").references(() => companies.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    emailKey: text("email_key").notNull(),
    ipAddress: text("ip_address"),
    success: boolean("success").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("login_attempts_email_idx").on(t.emailKey, t.attemptedAt),
    index("login_attempts_ip_idx").on(t.ipAddress, t.attemptedAt),
  ],
);

// ─── Entreprises ────────────────────────────────────────────────────────────

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legalName: text("legal_name").notNull(),
    tradeName: text("trade_name"),
    legalForm: text("legal_form"),
    siren: text("siren"),
    siret: text("siret"),
    vatNumber: text("vat_number"),
    nafCode: text("naf_code"),
    shareCapital: numeric("share_capital", { precision: 15, scale: 2 }),
    rcsCity: text("rcs_city"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    postalCode: text("postal_code"),
    city: text("city"),
    country: text("country").notNull().default("FR"),
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    iban: text("iban"),
    bic: text("bic"),
    fiscalYearStartMonth: smallint("fiscal_year_start_month").notNull().default(1),
    vatRegime: vatRegimeEnum("vat_regime").notNull().default("reel_normal"),
    /** Option pour le paiement de la TVA d'après les débits (prestations de services). */
    vatOnDebits: boolean("vat_on_debits").notNull().default(false),
    currency: text("currency").notNull().default("EUR"),
    locale: text("locale").notNull().default("fr-FR"),
    paymentTermsDays: smallint("payment_terms_days").notNull().default(30),
    latePenaltyText: text("late_penalty_text"),
    legalMentions: text("legal_mentions"),
    invoicePrefix: text("invoice_prefix").notNull().default("FA"),
    creditNotePrefix: text("credit_note_prefix").notNull().default("AV"),
    quotePrefix: text("quote_prefix").notNull().default("DE"),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("companies_fy_month_ck", sql`${t.fiscalYearStartMonth} between 1 and 12`),
    check("companies_terms_ck", sql`${t.paymentTermsDays} between 0 and 60`),
    check("companies_currency_ck", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.companyId] }), index("memberships_company_idx").on(t.companyId)],
);

// ─── Paramètres fiscaux ─────────────────────────────────────────────────────

export const vatRates = pgTable(
  "vat_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    label: text("label").notNull(),
    rate: numeric("rate", { precision: 5, scale: 2 }).notNull(),
    /** Mention légale obligatoire lorsque le taux est nul (exonération, autoliquidation…). */
    exemptionReason: text("exemption_reason"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("vat_rates_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("vat_rates_company_rate_reason_uq").on(t.companyId, t.rate, sql`coalesce(${t.exemptionReason}, '')`),
    check("vat_rates_range_ck", sql`${t.rate} >= 0 and ${t.rate} <= 100`),
    check("vat_rates_zero_reason_ck", sql`${t.rate} > 0 or ${t.exemptionReason} is not null`),
  ],
);

// ─── Numérotation ───────────────────────────────────────────────────────────

export const documentSequences = pgTable(
  "document_sequences",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    documentType: text("document_type").notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    lastValue: integer("last_value").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.documentType, t.fiscalYear] }),
    check("document_sequences_positive_ck", sql`${t.lastValue} >= 0`),
  ],
);

// ─── Journal d'audit chaîné (append-only) ───────────────────────────────────

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** null = événement hors entreprise (connexion, création de compte). Chaîne séparée. */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    /** Rang dans la chaîne de l'entreprise (ou de la chaîne système), continu à partir de 1. */
    chainSeq: integer("chain_seq").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    payload: jsonb("payload").notNull().default({}),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    uniqueIndex("audit_events_chain_uq").on(sql`coalesce(${t.companyId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.chainSeq),
    index("audit_events_entity_idx").on(t.companyId, t.entityType, t.entityId),
    index("audit_events_time_idx").on(t.companyId, t.occurredAt),
  ],
);

// ─── Tiers (clients et fournisseurs) ────────────────────────────────────────

export const partyTypeEnum = pgEnum("party_type", ["individual", "business", "public_entity"]);

export const thirdParties = pgTable(
  "third_parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    /** Code interne unique dans l'entreprise (ex. CLI-00012) ; servira de compte auxiliaire. */
    code: text("code").notNull(),
    isCustomer: boolean("is_customer").notNull().default(true),
    isSupplier: boolean("is_supplier").notNull().default(false),
    /** Particulier / professionnel : détermine notamment l'application de l'art. 286 I 3° bis CGI aux règlements. */
    partyType: partyTypeEnum("party_type").notNull(),
    name: text("name").notNull(),
    legalForm: text("legal_form"),
    siren: text("siren"),
    siret: text("siret"),
    vatNumber: text("vat_number"),
    email: text("email"),
    phone: text("phone"),
    billingLine1: text("billing_line1"),
    billingLine2: text("billing_line2"),
    billingPostalCode: text("billing_postal_code"),
    billingCity: text("billing_city"),
    billingCountry: text("billing_country").notNull().default("FR"),
    /** Adresse de livraison, si différente (nouvelle mention obligatoire de la facturation électronique). */
    shippingLine1: text("shipping_line1"),
    shippingLine2: text("shipping_line2"),
    shippingPostalCode: text("shipping_postal_code"),
    shippingCity: text("shipping_city"),
    shippingCountry: text("shipping_country"),
    /** null = délai par défaut de l'entreprise. */
    paymentTermsDays: smallint("payment_terms_days"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("third_parties_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("third_parties_id_company_uq").on(t.id, t.companyId),
    index("third_parties_company_name_idx").on(t.companyId, sql`lower(${t.name})`),
    index("third_parties_company_siren_idx").on(t.companyId, t.siren),
    check("third_parties_role_ck", sql`${t.isCustomer} or ${t.isSupplier}`),
    check("third_parties_terms_ck", sql`${t.paymentTermsDays} is null or ${t.paymentTermsDays} between 0 and 60`),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    thirdPartyId: uuid("third_party_id").notNull(),
    fullName: text("full_name").notNull(),
    jobTitle: text("job_title"),
    email: text("email"),
    phone: text("phone"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("contacts_third_party_idx").on(t.companyId, t.thirdPartyId),
    // Clé composite : un contact ne peut pointer que vers un tiers de la même entreprise.
    foreignKey({
      name: "contacts_third_party_company_fk",
      columns: [t.thirdPartyId, t.companyId],
      foreignColumns: [thirdParties.id, thirdParties.companyId],
    }).onDelete("cascade"),
  ],
);

// ─── Catalogue ──────────────────────────────────────────────────────────────

/** Bien ou service : « catégorie de l'opération », mention de la facturation électronique. */
export const productKindEnum = pgEnum("product_kind", ["good", "service"]);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    kind: productKindEnum("kind").notNull(),
    unit: text("unit").notNull(),
    unitPriceExclTax: numeric("unit_price_excl_tax", { precision: 15, scale: 4 }).notNull(),
    purchasePriceExclTax: numeric("purchase_price_excl_tax", { precision: 15, scale: 4 }),
    vatRateId: uuid("vat_rate_id").notNull(),
    barcode: text("barcode"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_company_reference_uq").on(t.companyId, sql`lower(${t.reference})`),
    index("products_company_name_idx").on(t.companyId, sql`lower(${t.name})`),
    index("products_company_barcode_idx").on(t.companyId, t.barcode),
    check("products_price_ck", sql`${t.unitPriceExclTax} >= 0`),
    // Clé composite : le taux de TVA doit appartenir à la même entreprise que le produit.
    foreignKey({
      name: "products_vat_rate_company_fk",
      columns: [t.vatRateId, t.companyId],
      foreignColumns: [vatRates.id, vatRates.companyId],
    }).onDelete("restrict"),
    check("products_purchase_ck", sql`${t.purchasePriceExclTax} is null or ${t.purchasePriceExclTax} >= 0`),
  ],
);

// ─── Idempotence des opérations financières ─────────────────────────────────

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.key] })],
);

export type User = typeof users.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Role = (typeof roleEnum.enumValues)[number];
export type ThirdParty = typeof thirdParties.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Product = typeof products.$inferSelect;
export type VatRate = typeof vatRates.$inferSelect;
