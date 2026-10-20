/**
 * Applique les migrations SQL versionnées (dossier drizzle/) sur la base DATABASE_URL.
 * Utilisation : npm run db:migrate
 * En production, à exécuter AVANT le démarrage de la nouvelle version, après sauvegarde.
 */
import { openDatabase } from "../src/server/db/client";

async function main() {
  const url = process.env.DATABASE_URL ?? "pglite:./.data/pglite";
  const handle = await openDatabase(url, { migrate: true });
  await handle.close();
  console.log(JSON.stringify({ level: "info", event: "db.migrated", kind: handle.kind }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
