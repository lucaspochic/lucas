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

export const MEMBER_ROLES =["owner", "admin", "accountant", "sales", "cashier", "viewer"] as const;
export const addMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(MEMBER_ROLES),
});
