import { eq } from "drizzle-orm";
import type { Executor } from "../db/client";
import { cashRegisters, type Company } from "../db/schema";
import { featuredModules, OPTIONAL_MODULES, type OptionalModule } from "@/lib/activities";
import { hasEquipment } from "./equipment";

/**
 * Modules optionnels affichés pour une entreprise : ceux qu'elle a activés, plus ceux qui
 * contiennent déjà des données (une caisse ou un parc existants restent toujours accessibles,
 * notamment pour les obligations de conservation). `featured` : modules mis en tête du menu
 * parce que l'activité de l'entreprise les suggère.
 */
export async function navigationModules(db: Executor, company: Pick<Company, "id" | "activities" | "modules">) {
  const enabled = new Set<string>(company.modules);
  if (!enabled.has("caisse")) {
    const [register] = await db.select({ id: cashRegisters.id }).from(cashRegisters).where(eq(cashRegisters.companyId, company.id)).limit(1);
    if (register) enabled.add("caisse");
  }
  if (!enabled.has("parc") && (await hasEquipment(db, company.id))) enabled.add("parc");
  const visible: OptionalModule[] = OPTIONAL_MODULES.filter((m) => enabled.has(m));
  return { visible, featured: featuredModules(company.activities, visible) };
}
