/**
 * Vérifie l'intégrité de toutes les chaînes d'audit (système + chaque entreprise).
 * Code de sortie 2 si une altération est détectée : utilisable en supervision (cron).
 * Utilisation : npm run audit:verify
 */
import { openDatabase } from "../src/server/db/client";
import { companies } from "../src/server/db/schema";
import { verifyAuditChain } from "../src/server/services/audit";

async function main() {
  const handle = await openDatabase(process.env.DATABASE_URL ?? "pglite:./.data/pglite", { migrate: false });
  let failures = 0;
  try {
    const chains: { id: string | null; name: string }[] = [
      { id: null, name: "système" },
      ...(await handle.db.select({ id: companies.id, name: companies.legalName }).from(companies)),
    ];
    for (const chain of chains) {
      const r = await verifyAuditChain(handle.db, chain.id);
      if (!r.valid) failures++;
      console.log(
        JSON.stringify({
          chain: chain.name,
          companyId: chain.id,
          valid: r.valid,
          events: r.eventsChecked,
          head: r.headHash,
          error: r.firstError,
        }),
      );
    }
  } finally {
    await handle.close();
  }
  process.exit(failures ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
