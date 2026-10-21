import { z } from "zod";
import {
  isValidFrenchVatNumber,
  isValidGtin,
  isValidIban,
  isValidNafCode,
  isValidSiren,
  isValidSiret,
  normalizeDigits,
} from "@/server/domain/identifiers";
import { isValidPrefix } from "@/server/domain/numbering";

/**
 * Schémas de validation partagés client / serveur.
 * Le serveur revalide TOUJOURS : la validation client n'est qu'un confort d'utilisation.
 */

const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, `${max} caractères au maximum.`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const passwordSchema = z
  .string()
  .min(12, "12 caractères au minimum.")
  .max(256, "256 caractères au maximum.");

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Adresse e-mail invalide.")).pipe(z.string().max(254));

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Mot de passe requis.").max(256),
});

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Nom requis.").max(120),
  email: emailSchema,
  password: passwordSchema,
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Mot de passe actuel requis."),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "Les mots de passe ne correspondent pas.",
  });

const sirenField = optionalText(20).refine((v) => !v || isValidSiren(v), "SIREN invalide (9 chiffres, clé de contrôle).")
  .transform((v) => (v ? normalizeDigits(v) : v));
const siretField = optionalText(20).refine((v) => !v || isValidSiret(v), "SIRET invalide (14 chiffres, clé de contrôle).")
  .transform((v) => (v ? normalizeDigits(v) : v));

export const VAT_REGIMES = ["reel_normal", "reel_simplifie", "mini_reel", "franchise_en_base"] as const;
export const VAT_REGIME_LABELS: Record<(typeof VAT_REGIMES)[number], string> = {
  reel_normal: "Réel normal",
  reel_simplifie: "Réel simplifié",
  mini_reel: "Mini-réel",
  franchise_en_base: "Franchise en base de TVA (art. 293 B du CGI)",
};

export const companySchema = z
  .object({
    legalName: z.string().trim().min(2, "Raison sociale requise.").max(200),
    tradeName: optionalText(),
    legalForm: optionalText(60),
    siren: sirenField,
    siret: siretField,
    vatNumber: optionalText(20)
      .transform((v) => (v ? v.replace(/\s/g, "").toUpperCase() : v))
      .refine((v) => !v || !v.startsWith("FR") || isValidFrenchVatNumber(v), "Numéro de TVA français invalide."),
    nafCode: optionalText(10)
      .transform((v) => (v ? v.toUpperCase().replace(".", "") : v))
      .refine((v) => !v || isValidNafCode(v), "Code APE/NAF invalide (ex. 6201Z)."),
    shareCapital: optionalText(20).refine((v) => !v || /^\d+(\.\d{1,2})?$/.test(v), "Montant invalide (ex. 10000.00)."),
    rcsCity: optionalText(80),
    addressLine1: optionalText(),
    addressLine2: optionalText(),
    postalCode: optionalText(10),
    city: optionalText(100),
    country: z.string().trim().length(2).toUpperCase().default("FR"),
    email: optionalText(254).refine((v) => !v || z.email().safeParse(v).success, "Adresse e-mail invalide."),
    phone: optionalText(30),
    website: optionalText(200),
    iban: optionalText(42)
      .transform((v) => (v ? v.replace(/\s/g, "").toUpperCase() : v))
      .refine((v) => !v || isValidIban(v), "IBAN invalide."),
    bic: optionalText(11)
      .transform((v) => (v ? v.toUpperCase() : v))
      .refine((v) => !v || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v), "BIC invalide."),
    fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).default(1),
    vatRegime: z.enum(VAT_REGIMES).default("reel_normal"),
    vatOnDebits: z.boolean().default(false),
    paymentTermsDays: z.coerce
      .number()
      .int()
      .min(0)
      .max(60, "Délai légal maximal : 60 jours (art. L. 441-10 du code de commerce)."),
    latePenaltyText: optionalText(1000),
    legalMentions: optionalText(2000),
    invoicePrefix: z.string().trim().toUpperCase().refine(isValidPrefix, "1 à 6 lettres ou chiffres."),
    creditNotePrefix: z.string().trim().toUpperCase().refine(isValidPrefix, "1 à 6 lettres ou chiffres."),
    quotePrefix: z.string().trim().toUpperCase().refine(isValidPrefix, "1 à 6 lettres ou chiffres."),
  })
  .superRefine((v, ctx) => {
    if (v.siren && v.siret && !v.siret.startsWith(v.siren)) {
      ctx.addIssue({ code: "custom", path: ["siret"], message: "Le SIRET doit commencer par le SIREN." });
    }
    if (v.siren && v.vatNumber?.startsWith("FR") && !v.vatNumber.endsWith(v.siren)) {
      ctx.addIssue({ code: "custom", path: ["vatNumber"], message: "Le numéro de TVA ne correspond pas au SIREN." });
    }
    if (v.vatRegime === "franchise_en_base" && v.vatOnDebits) {
      ctx.addIssue({ code: "custom", path: ["vatOnDebits"], message: "Option sans objet en franchise en base." });
    }
  });

export type CompanyInput = z.input<typeof companySchema>;
export type CompanyData = z.output<typeof companySchema>;

export const createCompanySchema = z.object({
  legalName: z.string().trim().min(2, "Raison sociale requise.").max(200),
  siren: sirenField,
  vatRegime: z.enum(VAT_REGIMES).default("reel_normal"),
});

// ─── Tiers ──────────────────────────────────────────────────────────────────

export const PARTY_TYPES = ["individual", "business", "public_entity"] as const;
export const PARTY_TYPE_LABELS: Record<(typeof PARTY_TYPES)[number], string> = {
  individual: "Particulier",
  business: "Professionnel",
  public_entity: "Organisme public",
};

const emailField = optionalText(254).refine((v) => !v || z.email().safeParse(v).success, "Adresse e-mail invalide.");
const countryField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Code pays ISO à 2 lettres (ex. FR).")
  .default("FR");

export const thirdPartySchema = z
  .object({
    code: optionalText(20).refine((v) => !v || /^[A-Za-z0-9._-]{1,20}$/.test(v), "Lettres, chiffres, « . _ - » uniquement."),
    isCustomer: z.boolean().default(true),
    isSupplier: z.boolean().default(false),
    partyType: z.enum(PARTY_TYPES),
    name: z.string().trim().min(1, "Nom requis.").max(200),
    legalForm: optionalText(60),
    siren: sirenField,
    siret: siretField,
    vatNumber: optionalText(20)
      .transform((v) => (v ? v.replace(/\s/g, "").toUpperCase() : v))
      .refine((v) => !v || !v.startsWith("FR") || isValidFrenchVatNumber(v), "Numéro de TVA français invalide."),
    email: emailField,
    phone: optionalText(30),
    billingLine1: optionalText(),
    billingLine2: optionalText(),
    billingPostalCode: optionalText(10),
    billingCity: optionalText(100),
    billingCountry: countryField,
    hasShippingAddress: z.boolean().default(false),
    shippingLine1: optionalText(),
    shippingLine2: optionalText(),
    shippingPostalCode: optionalText(10),
    shippingCity: optionalText(100),
    shippingCountry: optionalText(2).transform((v) => (v ? v.toUpperCase() : v)),
    paymentTermsDays: z
      .union([z.literal(""), z.coerce.number().int().min(0).max(60, "60 jours au maximum (art. L. 441-10 C. com.).")])
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
    notes: optionalText(5000),
  })
  .superRefine((v, ctx) => {
    if (!v.isCustomer && !v.isSupplier) {
      ctx.addIssue({ code: "custom", path: ["isCustomer"], message: "Cochez client, fournisseur ou les deux." });
    }
    if (v.partyType === "individual" && (v.siren || v.siret || v.vatNumber)) {
      ctx.addIssue({ code: "custom", path: ["partyType"], message: "Un particulier n'a ni SIREN, ni SIRET, ni numéro de TVA." });
    }
    if (v.siren && v.siret && !v.siret.startsWith(v.siren)) {
      ctx.addIssue({ code: "custom", path: ["siret"], message: "Le SIRET doit commencer par le SIREN." });
    }
    if (v.siren && v.vatNumber?.startsWith("FR") && !v.vatNumber.endsWith(v.siren)) {
      ctx.addIssue({ code: "custom", path: ["vatNumber"], message: "Le numéro de TVA ne correspond pas au SIREN." });
    }
    if (v.hasShippingAddress && (!v.shippingLine1 || !v.shippingPostalCode || !v.shippingCity)) {
      ctx.addIssue({ code: "custom", path: ["shippingLine1"], message: "Adresse de livraison incomplète." });
    }
  })
  // La sortie conserve hasShippingAddress : React Hook Form transmet au serveur les valeurs
  // DÉJÀ transformées, que le serveur revalide. Tout schéma partagé doit donc être idempotent
  // (vérifié par tests/unit/schemas.test.ts).
  .transform((v) =>
    v.hasShippingAddress
      ? { ...v, shippingCountry: v.shippingCountry ?? "FR" }
      : { ...v, shippingLine1: null, shippingLine2: null, shippingPostalCode: null, shippingCity: null, shippingCountry: null },
  );

export type ThirdPartyInput = z.input<typeof thirdPartySchema>;
export type ThirdPartyData = z.output<typeof thirdPartySchema>;

export const contactSchema = z.object({
  fullName: z.string().trim().min(1, "Nom requis.").max(120),
  jobTitle: optionalText(80),
  email: emailField,
  phone: optionalText(30),
  isPrimary: z.boolean().default(false),
});
export type ContactInput = z.input<typeof contactSchema>;

// ─── Catalogue ──────────────────────────────────────────────────────────────

export const PRODUCT_KINDS = ["good", "service"] as const;
export const PRODUCT_KIND_LABELS: Record<(typeof PRODUCT_KINDS)[number], string> = {
  good: "Bien (marchandise)",
  service: "Prestation de services",
};
export const UNITS = ["unité", "heure", "jour", "forfait", "mois", "kg", "g", "litre", "m", "m²", "m³", "lot"] as const;

const priceField = (label: string) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s  €]/g, "").replace(",", "."))
    .refine((v) => /^\d{1,11}(\.\d{1,4})?$/.test(v), `${label} : nombre positif, 4 décimales au maximum.`);

export const productSchema = z.object({
  reference: z
    .string()
    .trim()
    .min(1, "Référence requise.")
    .max(40)
    .regex(/^[A-Za-z0-9._/-]+$/, "Lettres, chiffres, « . _ / - » uniquement."),
  name: z.string().trim().min(1, "Désignation requise.").max(200),
  description: optionalText(2000),
  category: optionalText(80),
  kind: z.enum(PRODUCT_KINDS),
  unit: z.enum(UNITS),
  unitPriceExclTax: priceField("Prix de vente HT"),
  purchasePriceExclTax: z
    .union([z.literal(""), priceField("Prix d'achat HT")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  vatRateId: z.uuid("Taux de TVA requis."),
  barcode: optionalText(14).refine((v) => !v || isValidGtin(v), "Code-barres invalide (EAN-8, UPC, EAN-13 ; clé de contrôle)."),
});
export type ProductInput = z.input<typeof productSchema>;
export type ProductData = z.output<typeof productSchema>;

// ─── Documents de vente ─────────────────────────────────────────────────────

const decimalField = (label: string, maxDecimals: number, opts: { positive?: boolean; max?: number } = {}) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s  €%]/g, "").replace(",", "."))
    .refine((v) => new RegExp(`^\\d{1,11}(\\.\\d{1,${maxDecimals}})?$`).test(v), `${label} : nombre positif, ${maxDecimals} décimales au maximum.`)
    .refine((v) => !opts.positive || Number(v) > 0, `${label} : doit être supérieur à zéro.`)
    .refine((v) => opts.max === undefined || Number(v) <= opts.max, `${label} : ${opts.max} au maximum.`);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide.");

export const salesLineSchema = z.object({
  productId: z.uuid().nullable().optional(),
  reference: optionalText(40),
  description: z.string().trim().min(1, "Désignation requise.").max(2000),
  kind: z.enum(PRODUCT_KINDS),
  quantity: decimalField("Quantité", 3, { positive: true }),
  unit: z.enum(UNITS),
  unitPriceExclTax: decimalField("Prix unitaire HT", 4),
  discountPercent: decimalField("Remise", 2, { max: 100 }).default("0"),
  vatRateId: z.uuid("Taux de TVA requis."),
});
export type SalesLineInput = z.input<typeof salesLineSchema>;

export const salesDraftSchema = z.object({
  thirdPartyId: z.uuid("Client requis."),
  deliveryDate: z
    .union([z.literal(""), isoDate])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  globalDiscountPercent: decimalField("Remise globale", 2, { max: 100 }).default("0"),
  notes: optionalText(2000),
  lines: z.array(salesLineSchema).min(1, "Ajoutez au moins une ligne.").max(200, "200 lignes au maximum."),
});
export type SalesDraftInput = z.input<typeof salesDraftSchema>;
export type SalesDraftData = z.output<typeof salesDraftSchema>;

// ─── Règlements ─────────────────────────────────────────────────────────────

export const PAYMENT_METHODS = ["transfer", "card", "check", "cash", "direct_debit", "other"] as const;
export const PAYMENT_METHOD_LABELS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  transfer: "Virement",
  card: "Carte bancaire",
  check: "Chèque",
  cash: "Espèces",
  direct_debit: "Prélèvement",
  other: "Autre",
};

export const paymentSchema = z
  .object({
    /** Clé d'idempotence générée à l'ouverture du formulaire : un double envoi ne crée qu'un règlement. */
    idempotencyKey: z.uuid(),
    kind: z.enum(["receipt", "refund"]),
    /** Compte de trésorerie ; à défaut, compte par défaut (caisse pour les espèces, banque sinon). */
    bankAccountId: z.uuid().nullable().optional(),
    thirdPartyId: z.uuid("Client requis."),
    paymentDate: isoDate,
    method: z.enum(PAYMENT_METHODS),
    amount: decimalField("Montant", 2, { positive: true }),
    reference: optionalText(80),
    allocations: z
      .array(z.object({ documentId: z.uuid(), amount: decimalField("Montant imputé", 2) }))
      .max(100)
      .transform((list) => list.filter((a) => Number(a.amount) > 0)),
  })
  .superRefine((v, ctx) => {
    const ids = v.allocations.map((a) => a.documentId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["allocations"], message: "Facture imputée deux fois." });
  });
export type PaymentInput = z.input<typeof paymentSchema>;
export type PaymentData = z.output<typeof paymentSchema>;

// ─── Trésorerie et achats ───────────────────────────────────────────────────

export const bankAccountSchema = z.object({
  kind: z.enum(["bank", "cash"]),
  name: z.string().trim().min(2, "Nom requis.").max(60),
  bankName: optionalText(80),
  iban: optionalText(42)
    .transform((v) => (v ? v.replace(/\s/g, "").toUpperCase() : v))
    .refine((v) => !v || isValidIban(v), "IBAN invalide."),
  openingBalance: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s  €]/g, "").replace(",", ".") || "0")
    .refine((v) => /^-?\d{1,11}(\.\d{1,2})?$/.test(v), "Montant invalide."),
  openingDate: isoDate,
  ledgerAccount: z
    .string()
    .trim()
    .regex(/^(512|530)\d{0,5}$/, "Compte 512xxx (banque) ou 530xxx (caisse)."),
}).refine((v) => (v.kind === "bank") === v.ledgerAccount.startsWith("512"), {
  path: ["ledgerAccount"],
  message: "Banque : compte 512… ; caisse : compte 530….",
});

/**
 * Catégories de dépenses et comptes du plan comptable général associés (PCG, classe 6 ;
 * classe 2 pour les immobilisations). Liste indicative, à valider avec l'expert-comptable.
 */
export const EXPENSE_CATEGORIES = {
  marchandises: { label: "Achats de marchandises", account: "607000" },
  matieres: { label: "Matières premières et fournitures", account: "601000" },
  sous_traitance: { label: "Sous-traitance", account: "611000" },
  energie: { label: "Eau, électricité, gaz", account: "606100" },
  carburant: { label: "Carburant", account: "606140" },
  petit_materiel: { label: "Petit équipement et fournitures", account: "606300" },
  fournitures_bureau: { label: "Fournitures de bureau", account: "606400" },
  loyer: { label: "Loyers et charges locatives", account: "613200" },
  entretien: { label: "Entretien et réparations", account: "615000" },
  assurances: { label: "Assurances", account: "616000" },
  honoraires: { label: "Honoraires (comptable, avocat…)", account: "622600" },
  publicite: { label: "Publicité et communication", account: "623000" },
  transport: { label: "Transports de biens", account: "624100" },
  deplacements: { label: "Déplacements, missions, réceptions", account: "625100" },
  telecom: { label: "Téléphone et internet", account: "626000" },
  frais_bancaires: { label: "Frais bancaires", account: "627000" },
  logiciels: { label: "Abonnements et logiciels", account: "651000" },
  immobilisation: { label: "Matériel immobilisé (> 500 € HT)", account: "218300" },
  autre: { label: "Autres charges", account: "628000" },
} as const;
export type ExpenseCategory = keyof typeof EXPENSE_CATEGORIES;
export const EXPENSE_CATEGORY_KEYS = Object.keys(EXPENSE_CATEGORIES) as ExpenseCategory[];
export const FRENCH_VAT_RATES = ["20", "10", "5.5", "2.1", "0"] as const;

export const expenseLineSchema = z.object({
  category: z.enum(EXPENSE_CATEGORY_KEYS as [ExpenseCategory, ...ExpenseCategory[]]),
  description: z.string().trim().min(1, "Libellé requis.").max(300),
  amountExclTax: decimalField("Montant HT", 2, { positive: true }),
  vatRate: z.enum(FRENCH_VAT_RATES),
  /** TVA figurant sur la facture du fournisseur ; vide = calculée. */
  vatAmount: z
    .union([z.literal(""), decimalField("TVA", 2)])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
});

export const expenseSchema = z.object({
  thirdPartyId: z.uuid("Fournisseur requis."),
  supplierReference: optionalText(60),
  invoiceDate: isoDate,
  dueDate: z
    .union([z.literal(""), isoDate])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  notes: optionalText(2000),
  lines: z.array(expenseLineSchema).min(1, "Ajoutez au moins une ligne.").max(50),
});
export type ExpenseInput = z.input<typeof expenseSchema>;
export type ExpenseData = z.output<typeof expenseSchema>;

export const expensePaymentSchema = z.object({
  idempotencyKey: z.uuid(),
  /** Compte de trésorerie ; à défaut, compte par défaut selon le mode de paiement. */
  bankAccountId: z.uuid().nullable().optional(),
  paymentDate: isoDate,
  method: z.enum(PAYMENT_METHODS),
  amount: decimalField("Montant", 2, { positive: true }),
  reference: optionalText(80),
});

export const reversalSchema = z.object({
  idempotencyKey: z.uuid(),
  reason: z.string().trim().min(5, "Motif requis (5 caractères au minimum).").max(500),
});

export const MEMBER_ROLES =["owner", "admin", "accountant", "sales", "cashier", "viewer"] as const;
export const addMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(MEMBER_ROLES),
});
