/**
 * Reprise comptable des événements antérieurs au module comptable (idempotente).
 * Utilisation : npm run accounting:backfill   (application arrêtée si base PGlite)
 */
import { openDatabase } from "../src/server/db/client";
import { backfillAccounting } from "../src/server/services/accounting-backfill";

async function main() {
  const handle = await openDatabase(process.env.DATABASE_URL ?? "pglite:./.data/pglite", { migrate: true });
  try {
    for (const r of await backfillAccounting(handle.db)) console.log(JSON.stringify(r));
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
