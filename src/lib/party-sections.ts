/**
 * Clients et fournisseurs partagent la même fiche « tiers » (un tiers peut avoir les deux rôles),
 * mais sont présentés dans deux rubriques distinctes : /clients et /fournisseurs.
 */
export const PARTY_SECTIONS = ["clients", "fournisseurs"] as const;
export type PartySection = (typeof PARTY_SECTIONS)[number];

export const SECTION_INFO: Record<
  PartySection,
  { title: string; singular: string; newTitle: string; description: string; empty: string; other: PartySection; otherLabel: string }
> = {
  clients: {
    title: "Clients",
    singular: "client",
    newTitle: "Nouveau client",
    description: "Fiches clients, coordonnées, contacts et conditions de paiement.",
    empty: "Aucun client",
    other: "fournisseurs",
    otherLabel: "Aussi fournisseur",
  },
  fournisseurs: {
    title: "Fournisseurs",
    singular: "fournisseur",
    newTitle: "Nouveau fournisseur",
    description: "Fiches fournisseurs, coordonnées, contacts et conditions de paiement.",
    empty: "Aucun fournisseur",
    other: "clients",
    otherLabel: "Aussi client",
  },
};

export function isPartySection(value: unknown): value is PartySection {
  return value === "clients" || value === "fournisseurs";
}

export function hasRole(party: { isCustomer: boolean; isSupplier: boolean }, section: PartySection): boolean {
  return section === "clients" ? party.isCustomer : party.isSupplier;
}

/** Rubrique d'une fiche : celle demandée si le tiers y figure, sinon celle de son rôle (client d'abord). */
export function partySection(party: { isCustomer: boolean; isSupplier: boolean }, preferred?: PartySection): PartySection {
  if (preferred && hasRole(party, preferred)) return preferred;
  return party.isCustomer ? "clients" : "fournisseurs";
}

export function partyHref(party: { id: string; isCustomer: boolean; isSupplier: boolean }, preferred?: PartySection): string {
  return `/${partySection(party, preferred)}/${party.id}`;
}
