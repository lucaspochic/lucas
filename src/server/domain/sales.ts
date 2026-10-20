import type { Company, ThirdParty } from "../db/schema";

/**
 * Règles métier des documents de vente (fonctions pures).
 * Sources des mentions : CGI ann. II art. 242 nonies A ; C. com. art. L. 441-9, L. 441-10,
 * D. 441-5, R. 123-237 ; réforme de la facturation électronique (nouvelles mentions).
 * Voir docs/05-registre-reglementaire.md (R2, R4).
 */

export const DOCUMENT_TYPE_LABELS = { quote: "Devis", invoice: "Facture", credit_note: "Avoir" } as const;
export const DOCUMENT_STATUS_LABELS = {
  draft: "Brouillon",
  issued: "Émis",
  accepted: "Accepté",
  refused: "Refusé",
} as const;

export const QUOTE_VALIDITY_DAYS = 30;

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function operationCategoryOf(kinds: readonly ("good" | "service")[]): "goods" | "services" | "mixed" {
  const hasGood = kinds.includes("good");
  const hasService = kinds.includes("service");
  return hasGood && hasService ? "mixed" : hasGood ? "goods" : "services";
}

export interface SellerSnapshot {
  legalName: string;
  tradeName: string | null;
  legalForm: string | null;
  shareCapital: string | null;
  siren: string | null;
  siret: string | null;
  rcsCity: string | null;
  vatNumber: string | null;
  nafCode: string | null;
  address: string[];
  email: string | null;
  phone: string | null;
  iban: string | null;
  bic: string | null;
  vatRegime: string;
  vatOnDebits: boolean;
  latePenaltyText: string | null;
  legalMentions: string | null;
}

export interface CustomerSnapshot {
  code: string;
  name: string;
  partyType: "individual" | "business" | "public_entity";
  siren: string | null;
  vatNumber: string | null;
  billingAddress: string[];
  shippingAddress: string[] | null;
}

const compact = (parts: (string | null | undefined)[]) => parts.filter((p): p is string => !!p && p.trim() !== "");

export function sellerSnapshot(c: Company): SellerSnapshot {
  return {
    legalName: c.legalName,
    tradeName: c.tradeName,
    legalForm: c.legalForm,
    shareCapital: c.shareCapital,
    siren: c.siren,
    siret: c.siret,
    rcsCity: c.rcsCity,
    vatNumber: c.vatNumber,
    nafCode: c.nafCode,
    address: compact([c.addressLine1, c.addressLine2, compact([c.postalCode, c.city]).join(" "), c.country !== "FR" ? c.country : null]),
    email: c.email,
    phone: c.phone,
    iban: c.iban,
    bic: c.bic,
    vatRegime: c.vatRegime,
    vatOnDebits: c.vatOnDebits,
    latePenaltyText: c.latePenaltyText,
    legalMentions: c.legalMentions,
  };
}

export function customerSnapshot(t: ThirdParty): CustomerSnapshot {
  return {
    code: t.code,
    name: t.name,
    partyType: t.partyType,
    siren: t.siren,
    vatNumber: t.vatNumber,
    billingAddress: compact([
      t.billingLine1,
      t.billingLine2,
      compact([t.billingPostalCode, t.billingCity]).join(" "),
      t.billingCountry !== "FR" ? t.billingCountry : null,
    ]),
    shippingAddress: t.shippingLine1
      ? compact([
          t.shippingLine1,
          t.shippingLine2,
          compact([t.shippingPostalCode, t.shippingCity]).join(" "),
          t.shippingCountry && t.shippingCountry !== "FR" ? t.shippingCountry : null,
        ])
      : null,
  };
}

export interface IssueCheck {
  blocking: string[];
  warnings: string[];
}

/**
 * Contrôles préalables à l'émission. Les points bloquants correspondent à des mentions
 * obligatoires impossibles à produire ; les avertissements à des points à vérifier.
 */
export function checkBeforeIssue(type: "quote" | "invoice" | "credit_note", c: Company, t: ThirdParty, lineCount: number): IssueCheck {
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (lineCount === 0) blocking.push("Le document ne comporte aucune ligne.");
  if (!c.addressLine1 || !c.postalCode || !c.city) blocking.push("Adresse de votre entreprise incomplète (Paramètres › Entreprise).");
  if (c.country === "FR" && !c.siren) blocking.push("SIREN de votre entreprise manquant (Paramètres › Entreprise).");
  if (c.vatRegime !== "franchise_en_base" && !c.vatNumber) {
    blocking.push("Numéro de TVA intracommunautaire de votre entreprise manquant (Paramètres › Entreprise).");
  }
  if (!t.billingLine1 || !t.billingCity) blocking.push("Adresse de facturation du client incomplète.");
  if (type !== "quote") {
    if (!c.latePenaltyText) blocking.push("Mention des pénalités de retard manquante (Paramètres › Entreprise).");
    if (t.partyType === "business" && t.billingCountry === "FR" && !t.siren) {
      warnings.push(
        "SIREN du client professionnel manquant : mention exigée par la réforme de la facturation électronique.",
      );
    }
  }
  if (c.legalForm && !["Entreprise individuelle", "Association", "Autre"].includes(c.legalForm) && !c.shareCapital) {
    warnings.push("Capital social non renseigné (mention obligatoire pour les sociétés commerciales).");
  }
  return { blocking, warnings };
}

