import type { Company } from "../db/schema";

/**
 * Informations nécessaires avant l'émission de factures conformes
 * (mentions obligatoires : CGI art. 242 nonies A ; code de commerce art. L. 441-9 et R. 123-237).
 */
export function companySetupChecklist(c: Company) {
  const href = "/parametres/entreprise";
  return [
    { key: "identity", label: "Raison sociale et forme juridique", done: !!(c.legalName && c.legalForm), href },
    { key: "siren", label: "SIREN et SIRET", done: !!(c.siren && c.siret), href },
    { key: "address", label: "Adresse du siège", done: !!(c.addressLine1 && c.postalCode && c.city), href },
    {
      key: "vat",
      label: "Numéro de TVA intracommunautaire",
      done: c.vatRegime === "franchise_en_base" || !!c.vatNumber,
      href,
    },
    { key: "penalties", label: "Pénalités de retard et indemnité forfaitaire", done: !!c.latePenaltyText, href },
    { key: "bank", label: "Coordonnées bancaires", done: !!c.iban, href },
  ];
}
