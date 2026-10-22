import { sql } from "drizzle-orm";
import {
  bigint,
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
    /** Double authentification (TOTP) : secret chiffré (AES-256-GCM, security/encryption.ts). */
    mfaSecret: text("mfa_secret"),
    /** Secret en cours d'enrôlement, confirmé par un premier code. */
    mfaPendingSecret: text("mfa_pending_secret"),
    mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
    /** Dernier pas de temps accepté (un code ne sert qu'une fois). */
    mfaLastStep: bigint("mfa_last_step", { mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("users_mfa_ck", sql`(${t.mfaEnabledAt} is null) = (${t.mfaSecret} is null)`),
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

/** Codes de secours (usage unique), stockés hachés. */
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("mfa_recovery_codes_user_idx").on(t.userId)],
);

/** Défi de connexion : mot de passe vérifié, code de double authentification attendu. */
export const mfaChallenges = pgTable(
  "mfa_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mfa_challenges_token_uq").on(t.tokenHash)],
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
    /** Domaines d'activité déclarés (src/lib/activities.ts). */
    activities: text("activities").array().notNull().default(sql`'{}'::text[]`),
    /** Modules optionnels actifs ; ils déterminent l'agencement de la navigation. */
    modules: text("modules").array().notNull().default(sql`'{}'::text[]`),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("companies_fy_month_ck", sql`${t.fiscalYearStartMonth} between 1 and 12`),
    check("companies_terms_ck", sql`${t.paymentTermsDays} between 0 and 60`),
    check("companies_currency_ck", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "companies_activities_ck",
      sql`${t.activities} <@ array['vente_vehicules', 'materiel_agricole_tp', 'reparation_entretien', 'commerce_detail', 'restauration', 'artisanat_btp', 'negoce', 'services']::text[]`,
    ),
    check("companies_modules_ck", sql`${t.modules} <@ array['caisse', 'parc']::text[]`),
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
    uniqueIndex("products_id_company_uq").on(t.id, t.companyId),
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

// ─── Ventes : devis, factures, avoirs ───────────────────────────────────────

export const salesDocumentTypeEnum = pgEnum("sales_document_type", ["quote", "invoice", "credit_note"]);
/**
 * draft : brouillon modifiable, sans numéro ; issued : émis (numéroté, figé) ;
 * accepted / refused : réponse du client à un devis émis.
 */
export const salesDocumentStatusEnum = pgEnum("sales_document_status", ["draft", "issued", "accepted", "refused"]);
export const operationCategoryEnum = pgEnum("operation_category", ["goods", "services", "mixed"]);

export const salesDocuments = pgTable(
  "sales_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    type: salesDocumentTypeEnum("type").notNull(),
    status: salesDocumentStatusEnum("status").notNull().default("draft"),
    /** Attribué à l'émission uniquement ; null pour un brouillon. */
    number: text("number"),
    fiscalYear: integer("fiscal_year"),
    thirdPartyId: uuid("third_party_id").notNull(),
    /** Devis d'origine (facture) ou facture d'origine (avoir). */
    sourceDocumentId: uuid("source_document_id"),
    /** Facture d'acompte (ou avoir sur facture d'acompte) : HT en 419100, TVA des biens en attente de livraison. */
    isDeposit: boolean("is_deposit").notNull().default(false),
    issueDate: text("issue_date"),
    /** Échéance de paiement (facture) ou fin de validité (devis). */
    dueDate: text("due_date"),
    /** Date de la livraison ou de la prestation, si différente de la date d'émission. */
    deliveryDate: text("delivery_date"),
    operationCategory: operationCategoryEnum("operation_category"),
    globalDiscountPercent: numeric("global_discount_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    totalExclTax: numeric("total_excl_tax", { precision: 15, scale: 2 }).notNull().default("0"),
    totalVat: numeric("total_vat", { precision: 15, scale: 2 }).notNull().default("0"),
    totalInclTax: numeric("total_incl_tax", { precision: 15, scale: 2 }).notNull().default("0"),
    /** Montant réglé (mis à jour par le module de règlements). */
    amountPaid: numeric("amount_paid", { precision: 15, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("EUR"),
    notes: text("notes"),
    /** Coordonnées figées du vendeur et du client à l'émission (mentions obligatoires). */
    sellerSnapshot: jsonb("seller_snapshot"),
    customerSnapshot: jsonb("customer_snapshot"),
    /** Empreinte SHA-256 du contenu émis (contrôle d'intégrité, reprise dans le journal d'audit). */
    contentHash: text("content_hash"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "restrict" }),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sales_documents_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("sales_documents_number_uq").on(t.companyId, t.number),
    index("sales_documents_list_idx").on(t.companyId, t.type, t.status, t.issueDate),
    index("sales_documents_party_idx").on(t.companyId, t.thirdPartyId),
    index("sales_documents_source_idx").on(t.companyId, t.sourceDocumentId),
    foreignKey({
      name: "sales_documents_third_party_company_fk",
      columns: [t.thirdPartyId, t.companyId],
      foreignColumns: [thirdParties.id, thirdParties.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "sales_documents_source_company_fk",
      columns: [t.sourceDocumentId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }).onDelete("restrict"),
    check("sales_documents_number_ck", sql`(${t.status} = 'draft') = (${t.number} is null)`),
    check(
      "sales_documents_issued_ck",
      sql`${t.status} = 'draft' or (${t.issueDate} is not null and ${t.contentHash} is not null and ${t.issuedAt} is not null and ${t.fiscalYear} is not null)`,
    ),
    check("sales_documents_response_ck", sql`${t.status} not in ('accepted', 'refused') or ${t.type} = 'quote'`),
    check("sales_documents_credit_source_ck", sql`${t.type} <> 'credit_note' or ${t.sourceDocumentId} is not null`),
    check("sales_documents_discount_ck", sql`${t.globalDiscountPercent} between 0 and 100`),
    check("sales_documents_deposit_ck", sql`not ${t.isDeposit} or (${t.type} in ('invoice', 'credit_note') and ${t.sourceDocumentId} is not null)`),
    check("sales_documents_paid_ck", sql`${t.amountPaid} >= 0`),
  ],
);

export const salesDocumentLines = pgTable(
  "sales_document_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    documentId: uuid("document_id").notNull(),
    position: integer("position").notNull(),
    productId: uuid("product_id"),
    reference: text("reference"),
    description: text("description").notNull(),
    kind: productKindEnum("kind").notNull(),
    quantity: numeric("quantity", { precision: 15, scale: 3 }).notNull(),
    unit: text("unit").notNull(),
    unitPriceExclTax: numeric("unit_price_excl_tax", { precision: 15, scale: 4 }).notNull(),
    discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull(),
    vatExemptionReason: text("vat_exemption_reason"),
    totalExclTax: numeric("total_excl_tax", { precision: 15, scale: 2 }).notNull(),
    /** Facture de solde : facture d'acompte déduite par cette ligne (quantité négative). */
    deductedDocumentId: uuid("deducted_document_id"),
  },
  (t) => [
    uniqueIndex("sales_document_lines_position_uq").on(t.documentId, t.position),
    foreignKey({
      name: "sales_document_lines_deducted_company_fk",
      columns: [t.deductedDocumentId, t.companyId],
      foreignColumns: [salesDocuments.id, salesDocuments.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "sales_document_lines_document_company_fk",
      columns: [t.documentId, t.companyId],
      foreignColumns: [salesDocuments.id, salesDocuments.companyId],
    }).onDelete("cascade"),
    foreignKey({
      name: "sales_document_lines_product_company_fk",
      columns: [t.productId, t.companyId],
      foreignColumns: [products.id, products.companyId],
    }).onDelete("restrict"),
    check("sales_document_lines_qty_ck", sql`${t.quantity} > 0 or (${t.deductedDocumentId} is not null and ${t.quantity} < 0)`),
    check("sales_document_lines_price_ck", sql`${t.unitPriceExclTax} >= 0`),
    check("sales_document_lines_discount_ck", sql`${t.discountPercent} between 0 and 100`),
    check("sales_document_lines_vat_ck", sql`${t.vatRate} > 0 or ${t.vatExemptionReason} is not null`),
  ],
);

/** Ventilation de la TVA par taux, calculée et figée à l'émission. */
export const salesDocumentVat = pgTable(
  "sales_document_vat",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    documentId: uuid("document_id").notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull(),
    vatExemptionReason: text("vat_exemption_reason"),
    baseExclTax: numeric("base_excl_tax", { precision: 15, scale: 2 }).notNull(),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).notNull(),
  },
  (t) => [
    index("sales_document_vat_document_idx").on(t.documentId),
    foreignKey({
      name: "sales_document_vat_document_company_fk",
      columns: [t.documentId, t.companyId],
      foreignColumns: [salesDocuments.id, salesDocuments.companyId],
    }).onDelete("cascade"),
  ],
);

// ─── Règlements (encaissements, remboursements, contre-passations) ──────────

export const paymentMethodEnum = pgEnum("payment_method", ["cash", "check", "card", "transfer", "direct_debit", "other"]);
/** receipt : encaissement (> 0) ; refund : remboursement (< 0) ; reversal : contre-passation d'une erreur. */
export const paymentKindEnum = pgEnum("payment_kind", ["receipt", "refund", "reversal"]);

/**
 * Règlements : table en ajout seul (triggers, migration 0006), chaînée par empreinte SHA-256
 * par entreprise. Données exigées par le BOFiP (BOI-TVA-DECLA-30-10-30 §50) : n° de
 * justificatif, horodatage, montant, mode de paiement, imputation, traces des corrections.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    number: text("number").notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    kind: paymentKindEnum("kind").notNull(),
    /** Horodatage d'enregistrement (serveur). */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    /** Date du paiement déclarée (encaissement, date du chèque…), au plus la date du jour. */
    paymentDate: text("payment_date").notNull(),
    thirdPartyId: uuid("third_party_id").notNull(),
    /** Type du payeur au moment du règlement (particulier ⇒ obligations ISCA). */
    partyTypeSnapshot: partyTypeEnum("party_type_snapshot").notNull(),
    method: paymentMethodEnum("method").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    reference: text("reference"),
    reversesPaymentId: uuid("reverses_payment_id"),
    reason: text("reason"),
    /** Compte de trésorerie crédité (512 / 530) ; null pour les règlements antérieurs à l'itération 5. */
    bankAccountId: uuid("bank_account_id"),
    chainSeq: integer("chain_seq").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("payments_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("payments_number_uq").on(t.companyId, t.number),
    uniqueIndex("payments_chain_uq").on(t.companyId, t.chainSeq),
    uniqueIndex("payments_reverses_uq").on(t.reversesPaymentId),
    index("payments_party_idx").on(t.companyId, t.thirdPartyId),
    index("payments_date_idx").on(t.companyId, t.paymentDate),
    foreignKey({
      name: "payments_third_party_company_fk",
      columns: [t.thirdPartyId, t.companyId],
      foreignColumns: [thirdParties.id, thirdParties.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "payments_bank_account_company_fk",
      columns: [t.bankAccountId, t.companyId],
      foreignColumns: [bankAccounts.id, bankAccounts.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "payments_reverses_company_fk",
      columns: [t.reversesPaymentId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }).onDelete("restrict"),
    check("payments_amount_nonzero_ck", sql`${t.amount} <> 0`),
    check(
      "payments_kind_sign_ck",
      sql`(${t.kind} = 'receipt' and ${t.amount} > 0) or (${t.kind} = 'refund' and ${t.amount} < 0) or ${t.kind} = 'reversal'`,
    ),
    check(
      "payments_reversal_ck",
      sql`(${t.kind} = 'reversal') = (${t.reversesPaymentId} is not null) and (${t.kind} <> 'reversal' or ${t.reason} is not null)`,
    ),
  ],
);

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id").notNull(),
    documentId: uuid("document_id").notNull(),
    /** Montant imputé, de même signe que le règlement. */
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  },
  (t) => [
    index("payment_allocations_payment_idx").on(t.paymentId),
    index("payment_allocations_document_idx").on(t.companyId, t.documentId),
    uniqueIndex("payment_allocations_pair_uq").on(t.paymentId, t.documentId),
    foreignKey({
      name: "payment_allocations_payment_company_fk",
      columns: [t.paymentId, t.companyId],
      foreignColumns: [payments.id, payments.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "payment_allocations_document_company_fk",
      columns: [t.documentId, t.companyId],
      foreignColumns: [salesDocuments.id, salesDocuments.companyId],
    }).onDelete("restrict"),
    check("payment_allocations_nonzero_ck", sql`${t.amount} <> 0`),
  ],
);

// ─── Trésorerie ─────────────────────────────────────────────────────────────

export const treasuryAccountKindEnum = pgEnum("treasury_account_kind", ["bank", "cash"]);

/** Comptes de trésorerie : comptes bancaires (512) et caisse espèces (530). */
export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    kind: treasuryAccountKindEnum("kind").notNull(),
    name: text("name").notNull(),
    bankName: text("bank_name"),
    iban: text("iban"),
    openingBalance: numeric("opening_balance", { precision: 15, scale: 2 }).notNull().default("0"),
    openingDate: text("opening_date").notNull(),
    /** Compte comptable (ex. 512000, 512100, 530000). */
    ledgerAccount: text("ledger_account").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bank_accounts_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("bank_accounts_name_uq").on(t.companyId, sql`lower(${t.name})`),
    uniqueIndex("bank_accounts_ledger_uq").on(t.companyId, t.ledgerAccount),
    check("bank_accounts_ledger_ck", sql`${t.ledgerAccount} ~ '^(512|530)[0-9]{0,5}$'`),
  ],
);

/** Lignes de relevé bancaire importées (dédoublonnées par empreinte). */
export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    bankAccountId: uuid("bank_account_id").notNull(),
    operationDate: text("operation_date").notNull(),
    label: text("label").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    importId: uuid("import_id").notNull(),
    /** Rapprochement (état de travail, modifiable et tracé). */
    matchedPaymentId: uuid("matched_payment_id"),
    matchedExpensePaymentId: uuid("matched_expense_payment_id"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciledBy: uuid("reconciled_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bank_transactions_fingerprint_uq").on(t.bankAccountId, t.fingerprint),
    uniqueIndex("bank_transactions_payment_uq").on(t.matchedPaymentId),
    uniqueIndex("bank_transactions_expense_payment_uq").on(t.matchedExpensePaymentId),
    index("bank_transactions_account_idx").on(t.companyId, t.bankAccountId, t.operationDate),
    foreignKey({
      name: "bank_transactions_account_company_fk",
      columns: [t.bankAccountId, t.companyId],
      foreignColumns: [bankAccounts.id, bankAccounts.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "bank_transactions_payment_company_fk",
      columns: [t.matchedPaymentId, t.companyId],
      foreignColumns: [payments.id, payments.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "bank_transactions_expense_payment_company_fk",
      columns: [t.matchedExpensePaymentId, t.companyId],
      foreignColumns: [expensePayments.id, expensePayments.companyId],
    }).onDelete("restrict"),
    check("bank_transactions_single_match_ck", sql`${t.matchedPaymentId} is null or ${t.matchedExpensePaymentId} is null`),
  ],
);

// ─── Achats : dépenses (factures fournisseurs) et paiements fournisseurs ────

export const expenseStatusEnum = pgEnum("expense_status", ["draft", "validated"]);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    status: expenseStatusEnum("status").notNull().default("draft"),
    /** N° interne attribué à la validation (ACH-AAAA-NNNNN). */
    number: text("number"),
    fiscalYear: integer("fiscal_year"),
    thirdPartyId: uuid("third_party_id").notNull(),
    /** Référence de la facture du fournisseur. */
    supplierReference: text("supplier_reference"),
    invoiceDate: text("invoice_date").notNull(),
    dueDate: text("due_date"),
    totalExclTax: numeric("total_excl_tax", { precision: 15, scale: 2 }).notNull().default("0"),
    totalVat: numeric("total_vat", { precision: 15, scale: 2 }).notNull().default("0"),
    totalInclTax: numeric("total_incl_tax", { precision: 15, scale: 2 }).notNull().default("0"),
    amountPaid: numeric("amount_paid", { precision: 15, scale: 2 }).notNull().default("0"),
    notes: text("notes"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    validatedBy: uuid("validated_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("expenses_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("expenses_number_uq").on(t.companyId, t.number),
    index("expenses_list_idx").on(t.companyId, t.status, t.invoiceDate),
    foreignKey({
      name: "expenses_third_party_company_fk",
      columns: [t.thirdPartyId, t.companyId],
      foreignColumns: [thirdParties.id, thirdParties.companyId],
    }).onDelete("restrict"),
    check("expenses_number_ck", sql`(${t.status} = 'draft') = (${t.number} is null)`),
    check("expenses_paid_ck", sql`${t.amountPaid} >= 0`),
  ],
);

export const expenseLines = pgTable(
  "expense_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    expenseId: uuid("expense_id").notNull(),
    position: integer("position").notNull(),
    category: text("category").notNull(),
    /** Compte de charge (classe 6) ou d'immobilisation (classe 2) associé à la catégorie. */
    ledgerAccount: text("ledger_account").notNull(),
    description: text("description").notNull(),
    amountExclTax: numeric("amount_excl_tax", { precision: 15, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull(),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex("expense_lines_position_uq").on(t.expenseId, t.position),
    foreignKey({
      name: "expense_lines_expense_company_fk",
      columns: [t.expenseId, t.companyId],
      foreignColumns: [expenses.id, expenses.companyId],
    }).onDelete("cascade"),
    check("expense_lines_amount_ck", sql`${t.amountExclTax} > 0 and ${t.vatAmount} >= 0`),
  ],
);

/** Paiements fournisseurs : en ajout seul (contre-passation pour corriger). */
export const expensePayments = pgTable(
  "expense_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    number: text("number").notNull(),
    expenseId: uuid("expense_id").notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    paymentDate: text("payment_date").notNull(),
    method: paymentMethodEnum("method").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    reference: text("reference"),
    reversesId: uuid("reverses_id"),
    reason: text("reason"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("expense_payments_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("expense_payments_number_uq").on(t.companyId, t.number),
    uniqueIndex("expense_payments_reverses_uq").on(t.reversesId),
    index("expense_payments_expense_idx").on(t.companyId, t.expenseId),
    foreignKey({
      name: "expense_payments_expense_company_fk",
      columns: [t.expenseId, t.companyId],
      foreignColumns: [expenses.id, expenses.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "expense_payments_account_company_fk",
      columns: [t.bankAccountId, t.companyId],
      foreignColumns: [bankAccounts.id, bankAccounts.companyId],
    }).onDelete("restrict"),
    check("expense_payments_amount_ck", sql`${t.amount} <> 0`),
    check("expense_payments_reversal_ck", sql`(${t.reversesId} is null) = (${t.amount} > 0) and (${t.reversesId} is null or ${t.reason} is not null)`),
  ],
);

// ─── Comptabilité ───────────────────────────────────────────────────────────

/** Plan de comptes de l'entreprise (PCG). */
export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    number: text("number").notNull(),
    label: text("label").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ledger_accounts_number_uq").on(t.companyId, t.number),
    check("ledger_accounts_number_ck", sql`${t.number} ~ '^[1-7][0-9]{2,7}$'`),
  ],
);

export const journalKindEnum = pgEnum("journal_kind", ["sales", "purchases", "bank", "cash", "misc"]);

export const journals = pgTable(
  "journals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    label: text("label").notNull(),
    kind: journalKindEnum("kind").notNull(),
    bankAccountId: uuid("bank_account_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("journals_code_uq").on(t.companyId, t.code),
    uniqueIndex("journals_bank_account_uq").on(t.bankAccountId),
    foreignKey({
      name: "journals_bank_account_company_fk",
      columns: [t.bankAccountId, t.companyId],
      foreignColumns: [bankAccounts.id, bankAccounts.companyId],
    }).onDelete("restrict"),
  ],
);

/**
 * Écritures comptables : générées automatiquement, validées dès leur création (pas de
 * brouillard), en ajout seul. `entrySeq` : numéro continu par entreprise et par exercice,
 * tous journaux confondus (zone FEC EcritureNum).
 */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    journalCode: text("journal_code").notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    entrySeq: integer("entry_seq").notNull(),
    entryDate: text("entry_date").notNull(),
    pieceRef: text("piece_ref").notNull(),
    pieceDate: text("piece_date").notNull(),
    label: text("label").notNull(),
    /** Origine unique (ex. « sales:<id> », « payment:<id> ») : une écriture par événement. */
    sourceKey: text("source_key").notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("journal_entries_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("journal_entries_seq_uq").on(t.companyId, t.fiscalYear, t.entrySeq),
    uniqueIndex("journal_entries_source_uq").on(t.companyId, t.sourceKey),
    index("journal_entries_date_idx").on(t.companyId, t.entryDate),
    foreignKey({
      name: "journal_entries_journal_fk",
      columns: [t.companyId, t.journalCode],
      foreignColumns: [journals.companyId, journals.code],
    }).onDelete("restrict"),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    entryId: uuid("entry_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountNumber: text("account_number").notNull(),
    auxNumber: text("aux_number"),
    auxLabel: text("aux_label"),
    label: text("label").notNull(),
    debit: numeric("debit", { precision: 15, scale: 2 }).notNull().default("0"),
    credit: numeric("credit", { precision: 15, scale: 2 }).notNull().default("0"),
  },
  (t) => [
    uniqueIndex("journal_lines_no_uq").on(t.entryId, t.lineNo),
    index("journal_lines_account_idx").on(t.companyId, t.accountNumber),
    foreignKey({
      name: "journal_lines_entry_company_fk",
      columns: [t.entryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "journal_lines_account_fk",
      columns: [t.companyId, t.accountNumber],
      foreignColumns: [ledgerAccounts.companyId, ledgerAccounts.number],
    }).onDelete("restrict"),
    check("journal_lines_amounts_ck", sql`${t.debit} >= 0 and ${t.credit} >= 0 and (${t.debit} = 0) <> (${t.credit} = 0)`),
  ],
);

/**
 * Lettrage : rapprochement de lignes d'un même compte (et compte auxiliaire) dont la somme
 * est nulle (facture ↔ règlements). Les lignes d'écriture restant intangibles, le lettrage
 * est porté par ces tables. Délettrage : groupe marqué, liens supprimés (tracé à l'audit).
 */
export const letterings = pgTable(
  "letterings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    accountNumber: text("account_number").notNull(),
    auxNumber: text("aux_number"),
    /** Code de lettrage (A, B… Z, AA…), unique par compte : zone FEC EcritureLet. */
    code: text("code").notNull(),
    method: text("method").$type<"auto" | "manual">().notNull(),
    letteredAt: timestamp("lettered_at", { withTimezone: true }).notNull(),
    letteredBy: uuid("lettered_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    unletteredAt: timestamp("unlettered_at", { withTimezone: true }),
    unletteredBy: uuid("unlettered_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("letterings_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("letterings_code_uq").on(t.companyId, t.accountNumber, t.code),
    check("letterings_method_ck", sql`${t.method} in ('auto', 'manual')`),
  ],
);

export const letteringLines = pgTable(
  "lettering_lines",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    letteringId: uuid("lettering_id").notNull(),
    lineId: uuid("line_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.lineId] }),
    index("lettering_lines_group_idx").on(t.letteringId),
    foreignKey({
      name: "lettering_lines_group_company_fk",
      columns: [t.letteringId, t.companyId],
      foreignColumns: [letterings.id, letterings.companyId],
    }).onDelete("restrict"),
    foreignKey({ name: "lettering_lines_line_fk", columns: [t.lineId], foreignColumns: [journalLines.id] }).onDelete("restrict"),
  ],
);

/** Exercices clôturés : aucune écriture ne peut plus y être enregistrée (trigger). */
export const fiscalYearClosures = pgTable(
  "fiscal_year_closures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    fiscalYear: integer("fiscal_year").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    /** Résultat de l'exercice (produits − charges) ; positif = bénéfice. */
    result: numeric("result", { precision: 15, scale: 2 }).notNull(),
    totalDebit: numeric("total_debit", { precision: 15, scale: 2 }).notNull(),
    totalCredit: numeric("total_credit", { precision: 15, scale: 2 }).notNull(),
    entryCount: integer("entry_count").notNull(),
    openingEntryId: uuid("opening_entry_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    closedBy: uuid("closed_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [uniqueIndex("fiscal_year_closures_uq").on(t.companyId, t.fiscalYear)],
);

// ─── Relances ───────────────────────────────────────────────────────────────

/** Relances de factures impayées : historique en ajout seul (niveau, date, canal, montant dû). */
export const paymentReminders = pgTable(
  "payment_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    documentId: uuid("document_id").notNull(),
    level: smallint("level").notNull(),
    channel: text("channel").$type<"email" | "letter" | "other">().notNull(),
    recipient: text("recipient"),
    amountDue: numeric("amount_due", { precision: 15, scale: 2 }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("payment_reminders_document_idx").on(t.companyId, t.documentId),
    foreignKey({
      name: "payment_reminders_document_company_fk",
      columns: [t.documentId, t.companyId],
      foreignColumns: [salesDocuments.id, salesDocuments.companyId],
    }).onDelete("restrict"),
    check("payment_reminders_level_ck", sql`${t.level} between 1 and 3`),
    check("payment_reminders_channel_ck", sql`${t.channel} in ('email', 'letter', 'other')`),
  ],
);

// ─── Parc matériel (module « parc ») ────────────────────────────────────────

/**
 * Matériel détenu par un client (véhicule, tracteur, engin…), vendu ou suivi par l'entreprise.
 * Le propriétaire peut changer (revente, reprise) : chaque changement est tracé dans le
 * journal d'audit. Pas de suppression : archivage.
 */
export const equipment = pgTable(
  "equipment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    thirdPartyId: uuid("third_party_id").notNull(),
    category: text("category").$type<"vehicle" | "agricultural" | "construction" | "other">().notNull(),
    brand: text("brand").notNull(),
    model: text("model").notNull(),
    /** Numéro de série, ou numéro VIN pour un véhicule (17 caractères). */
    serialNumber: text("serial_number"),
    registration: text("registration"),
    year: smallint("year"),
    meterValue: integer("meter_value"),
    meterUnit: text("meter_unit").$type<"km" | "h">(),
    /** AAAA-MM-JJ */
    soldOn: text("sold_on"),
    /** Facture de vente émise au même client. */
    salesDocumentId: uuid("sales_document_id"),
    warrantyEndsOn: text("warranty_ends_on"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("equipment_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("equipment_company_serial_uq").on(t.companyId, sql`upper(${t.serialNumber})`).where(sql`${t.serialNumber} is not null`),
    index("equipment_company_party_idx").on(t.companyId, t.thirdPartyId),
    index("equipment_company_registration_idx").on(t.companyId, t.registration),
    foreignKey({
      name: "equipment_third_party_company_fk",
      columns: [t.thirdPartyId, t.companyId],
      foreignColumns: [thirdParties.id, thirdParties.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "equipment_sales_document_company_fk",
      columns: [t.salesDocumentId, t.companyId],
      foreignColumns: [salesDocuments.id, salesDocuments.companyId],
    }).onDelete("restrict"),
    check("equipment_category_ck", sql`${t.category} in ('vehicle', 'agricultural', 'construction', 'other')`),
    check("equipment_year_ck", sql`${t.year} is null or ${t.year} between 1900 and 2100`),
    check("equipment_meter_ck", sql`(${t.meterValue} is null) = (${t.meterUnit} is null) and (${t.meterValue} is null or ${t.meterValue} >= 0)`),
    check("equipment_meter_unit_ck", sql`${t.meterUnit} is null or ${t.meterUnit} in ('km', 'h')`),
    check("equipment_sold_on_ck", sql`${t.soldOn} is null or ${t.soldOn} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
    check("equipment_warranty_ck", sql`${t.warrantyEndsOn} is null or ${t.warrantyEndsOn} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  ],
);

// ─── Pièces jointes ─────────────────────────────────────────────────────────

/**
 * Pièces jointes (justificatifs) : métadonnées en base, contenu sur disque, adressé par
 * empreinte SHA-256 et rangé par entreprise. Retrait possible tant que la pièce ne justifie
 * pas une opération validée (service) ; le retrait est un marquage, jamais un effacement.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    entityType: text("entity_type").$type<"expense" | "sales_document" | "third_party" | "equipment">().notNull(),
    entityId: uuid("entity_id").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("attachments_entity_idx").on(t.companyId, t.entityType, t.entityId),
    check("attachments_entity_ck", sql`${t.entityType} in ('expense', 'sales_document', 'third_party', 'equipment')`),
    check("attachments_size_ck", sql`${t.size} > 0`),
    check("attachments_sha_ck", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

// ─── Caisse (art. 286, I, 3° bis CGI — conditions ISCA) ─────────────────────

export const cashRegisters = pgTable(
  "cash_registers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    /** N° de caisse figurant sur les tickets (BOFiP §50). */
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** Compte de trésorerie « caisse » recevant les espèces. */
    cashAccountId: uuid("cash_account_id").notNull(),
    createdAt: createdAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("cash_registers_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("cash_registers_code_uq").on(t.companyId, t.code),
    foreignKey({
      name: "cash_registers_account_company_fk",
      columns: [t.cashAccountId, t.companyId],
      foreignColumns: [bankAccounts.id, bankAccounts.companyId],
    }).onDelete("restrict"),
    check("cash_registers_code_ck", sql`${t.code} ~ '^[A-Z0-9]{1,6}$'`),
  ],
);

/** Sessions de caisse : fond de caisse à l'ouverture, comptage et écart à la fermeture. */
export const cashSessions = pgTable(
  "cash_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    registerId: uuid("register_id").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    openedBy: uuid("opened_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    openingFloat: numeric("opening_float", { precision: 15, scale: 2 }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "restrict" }),
    expectedCash: numeric("expected_cash", { precision: 15, scale: 2 }),
    countedCash: numeric("counted_cash", { precision: 15, scale: 2 }),
    difference: numeric("difference", { precision: 15, scale: 2 }),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("cash_sessions_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("cash_sessions_one_open_uq").on(t.registerId).where(sql`${t.closedAt} is null`),
    foreignKey({
      name: "cash_sessions_register_company_fk",
      columns: [t.registerId, t.companyId],
      foreignColumns: [cashRegisters.id, cashRegisters.companyId],
    }).onDelete("restrict"),
    check("cash_sessions_float_ck", sql`${t.openingFloat} >= 0`),
  ],
);

export const cashTicketKindEnum = pgEnum("cash_ticket_kind", ["sale", "refund"]);

/**
 * Tickets : en ajout seul, numérotés en continu par caisse et chaînés (empreinte du
 * précédent). Un remboursement ou une annulation est un nouveau ticket négatif lié.
 */
export const cashTickets = pgTable(
  "cash_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    registerId: uuid("register_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    /** Rang continu dans la caisse (= maillon de chaîne). */
    seq: integer("seq").notNull(),
    number: text("number").notNull(),
    kind: cashTicketKindEnum("kind").notNull(),
    refundOfId: uuid("refund_of_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    /** Date calendaire (Europe/Paris) de rattachement pour les clôtures. */
    businessDate: text("business_date").notNull(),
    operatorId: uuid("operator_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    thirdPartyId: uuid("third_party_id"),
    /** Mode école : enregistré et chaîné, mais exclu des totaux et de la comptabilité. */
    training: boolean("training").notNull().default(false),
    totalExclTax: numeric("total_excl_tax", { precision: 15, scale: 2 }).notNull(),
    totalVat: numeric("total_vat", { precision: 15, scale: 2 }).notNull(),
    totalInclTax: numeric("total_incl_tax", { precision: 15, scale: 2 }).notNull(),
    reason: text("reason"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    uniqueIndex("cash_tickets_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("cash_tickets_seq_uq").on(t.registerId, t.seq),
    uniqueIndex("cash_tickets_number_uq").on(t.companyId, t.number),
    index("cash_tickets_date_idx").on(t.registerId, t.businessDate),
    foreignKey({
      name: "cash_tickets_register_company_fk",
      columns: [t.registerId, t.companyId],
      foreignColumns: [cashRegisters.id, cashRegisters.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "cash_tickets_session_company_fk",
      columns: [t.sessionId, t.companyId],
      foreignColumns: [cashSessions.id, cashSessions.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "cash_tickets_refund_company_fk",
      columns: [t.refundOfId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "cash_tickets_party_company_fk",
      columns: [t.thirdPartyId, t.companyId],
      foreignColumns: [thirdParties.id, thirdParties.companyId],
    }).onDelete("restrict"),
    check("cash_tickets_sign_ck", sql`(${t.kind} = 'sale' and ${t.totalInclTax} >= 0) or (${t.kind} = 'refund' and ${t.totalInclTax} <= 0)`),
    check("cash_tickets_refund_ck", sql`(${t.kind} = 'refund') = (${t.refundOfId} is not null) and (${t.kind} = 'sale' or ${t.reason} is not null)`),
  ],
);

export const cashTicketLines = pgTable(
  "cash_ticket_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    ticketId: uuid("ticket_id").notNull(),
    position: integer("position").notNull(),
    productId: uuid("product_id"),
    label: text("label").notNull(),
    kind: productKindEnum("kind").notNull(),
    quantity: numeric("quantity", { precision: 15, scale: 3 }).notNull(),
    unitPriceInclTax: numeric("unit_price_incl_tax", { precision: 15, scale: 4 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull(),
    totalInclTax: numeric("total_incl_tax", { precision: 15, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex("cash_ticket_lines_position_uq").on(t.ticketId, t.position),
    foreignKey({
      name: "cash_ticket_lines_ticket_company_fk",
      columns: [t.ticketId, t.companyId],
      foreignColumns: [cashTickets.id, cashTickets.companyId],
    }).onDelete("restrict"),
  ],
);

export const cashTicketPayments = pgTable(
  "cash_ticket_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    ticketId: uuid("ticket_id").notNull(),
    method: paymentMethodEnum("method").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  },
  (t) => [
    index("cash_ticket_payments_ticket_idx").on(t.ticketId),
    foreignKey({
      name: "cash_ticket_payments_ticket_company_fk",
      columns: [t.ticketId, t.companyId],
      foreignColumns: [cashTickets.id, cashTickets.companyId],
    }).onDelete("restrict"),
  ],
);

export const cashClosureKindEnum = pgEnum("cash_closure_kind", ["day", "month", "year"]);

/**
 * Clôtures journalières, mensuelles et annuelles (cumulatives et impératives) : grand
 * total de la période et total perpétuel jamais remis à zéro ; chaînées et signées.
 */
export const cashClosures = pgTable(
  "cash_closures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    registerId: uuid("register_id").notNull(),
    kind: cashClosureKindEnum("kind").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    seq: integer("seq").notNull(),
    ticketCount: integer("ticket_count").notNull(),
    firstTicketSeq: integer("first_ticket_seq"),
    lastTicketSeq: integer("last_ticket_seq"),
    lastTicketHash: text("last_ticket_hash"),
    totalExclTax: numeric("total_excl_tax", { precision: 15, scale: 2 }).notNull(),
    totalVat: numeric("total_vat", { precision: 15, scale: 2 }).notNull(),
    /** Grand total de la période (TTC, ventes − remboursements, hors mode école). */
    grandTotal: numeric("grand_total", { precision: 15, scale: 2 }).notNull(),
    /** Total perpétuel : cumul depuis la mise en service, jamais remis à zéro. */
    perpetualTotal: numeric("perpetual_total", { precision: 15, scale: 2 }).notNull(),
    /** Cumul perpétuel des valeurs absolues (ventes + remboursements). */
    perpetualAbsoluteTotal: numeric("perpetual_absolute_total", { precision: 15, scale: 2 }).notNull(),
    vatBreakdown: jsonb("vat_breakdown").notNull(),
    paymentBreakdown: jsonb("payment_breakdown").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "restrict" }),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    signature: text("signature").notNull(),
    keyId: text("key_id").notNull(),
  },
  (t) => [
    uniqueIndex("cash_closures_period_uq").on(t.registerId, t.kind, t.periodStart),
    uniqueIndex("cash_closures_seq_uq").on(t.registerId, t.seq),
    foreignKey({
      name: "cash_closures_register_company_fk",
      columns: [t.registerId, t.companyId],
      foreignColumns: [cashRegisters.id, cashRegisters.companyId],
    }).onDelete("restrict"),
  ],
);

export const cashArchives = pgTable(
  "cash_archives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    registerId: uuid("register_id").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    fileName: text("file_name").notNull(),
    sha256: text("sha256").notNull(),
    signature: text("signature").notNull(),
    keyId: text("key_id").notNull(),
    createdAt: createdAt(),
    createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    foreignKey({
      name: "cash_archives_register_company_fk",
      columns: [t.registerId, t.companyId],
      foreignColumns: [cashRegisters.id, cashRegisters.companyId],
    }).onDelete("restrict"),
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
export type SalesDocument = typeof salesDocuments.$inferSelect;
export type SalesDocumentLine = typeof salesDocumentLines.$inferSelect;
export type SalesDocumentType = (typeof salesDocumentTypeEnum.enumValues)[number];
export type Payment = typeof payments.$inferSelect;
export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
export type BankAccount = typeof bankAccounts.$inferSelect;
export type BankTransaction = typeof bankTransactions.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type ExpenseLine = typeof expenseLines.$inferSelect;
export type ExpensePayment = typeof expensePayments.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalLine = typeof journalLines.$inferSelect;
export type Lettering = typeof letterings.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type PaymentReminder = typeof paymentReminders.$inferSelect;
export type FiscalYearClosure = typeof fiscalYearClosures.$inferSelect;
export type CashRegister = typeof cashRegisters.$inferSelect;
export type CashSession = typeof cashSessions.$inferSelect;
export type CashTicket = typeof cashTickets.$inferSelect;
export type CashTicketLine = typeof cashTicketLines.$inferSelect;
export type CashClosure = typeof cashClosures.$inferSelect;
export type Equipment = typeof equipment.$inferSelect;
