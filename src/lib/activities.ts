/**
 * Domaines d'activité de l'entreprise et modules optionnels qu'ils proposent.
 * Le choix des activités pré-coche les modules adaptés ; l'entreprise garde la main
 * (paramètres) et l'agencement de la navigation suit les modules retenus.
 * Les modules de base (ventes, règlements, dépenses, trésorerie, comptabilité) restent toujours présents.
 */

export const OPTIONAL_MODULES = ["caisse", "parc"] as const;
export type OptionalModule = (typeof OPTIONAL_MODULES)[number];

export const MODULE_INFO: Record<OptionalModule, { label: string; description: string }> = {
  caisse: {
    label: "Caisse",
    description: "Encaissement au comptoir (tickets, clôtures journalières, archives signées).",
  },
  parc: {
    label: "Parc matériel",
    description: "Matériels vendus ou suivis par client : marque, modèle, n° de série, immatriculation, garantie.",
  },
};

export const ACTIVITIES = [
  "vente_vehicules",
  "materiel_agricole_tp",
  "reparation_entretien",
  "commerce_detail",
  "restauration",
  "artisanat_btp",
  "negoce",
  "services",
] as const;
export type Activity = (typeof ACTIVITIES)[number];

export const ACTIVITY_INFO: Record<Activity, { label: string; hint: string; modules: readonly OptionalModule[] }> = {
  vente_vehicules: { label: "Vente de véhicules", hint: "Automobiles, utilitaires, deux-roues", modules: ["parc"] },
  materiel_agricole_tp: { label: "Vente de matériel agricole, TP ou industriel", hint: "Tracteurs, engins, machines", modules: ["parc"] },
  reparation_entretien: { label: "Réparation, entretien, SAV", hint: "Garage, atelier, maintenance", modules: ["parc"] },
  commerce_detail: { label: "Commerce de détail", hint: "Boutique, magasin, vente au comptoir", modules: ["caisse"] },
  restauration: { label: "Restauration, métiers de bouche", hint: "Restaurant, boulangerie, traiteur", modules: ["caisse"] },
  artisanat_btp: { label: "Artisanat, bâtiment", hint: "Chantiers sur devis", modules: [] },
  negoce: { label: "Négoce, vente aux professionnels", hint: "Grossiste, distributeur", modules: [] },
  services: { label: "Prestations de services", hint: "Conseil, formation, prestations intellectuelles", modules: [] },
};

/** Modules suggérés par un ensemble d'activités, dans l'ordre canonique. */
export function suggestedModules(activities: readonly string[]): OptionalModule[] {
  const wanted = new Set(activities.flatMap((a) => ACTIVITY_INFO[a as Activity]?.modules ?? []));
  return OPTIONAL_MODULES.filter((m) => wanted.has(m));
}

/** Liste dédoublonnée et triée selon l'ordre de référence (idempotent : formulaires et serveur). */
export function normalizeList<T extends string>(values: readonly string[], allowed: readonly T[]): T[] {
  const set = new Set(values);
  return allowed.filter((v) => set.has(v));
}

/**
 * Module mis en avant dans la navigation : celui que suggère l'activité principale
 * (première activité cochée dans l'ordre de référence), s'il est actif.
 */
export function featuredModules(activities: readonly string[], modules: readonly string[]): OptionalModule[] {
  const active = new Set(modules);
  return suggestedModules(activities).filter((m) => active.has(m));
}
