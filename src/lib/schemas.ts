import { z } from "zod";
import {
  isValidFrenchVatNumber,
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

export const MEMBER_ROLES = ["owner", "admin", "accountant", "sales", "cashier", "viewer"] as const;
export const addMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(MEMBER_ROLES),
});
