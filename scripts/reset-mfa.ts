/**
 * Désactive la double authentification d'un utilisateur (téléphone et codes de secours perdus).
 * Utilisation : npm run user:reset-mfa -- adresse@exemple.fr
 * À n'exécuter qu'après avoir vérifié l'identité du demandeur par un canal sûr.
 * Toutes ses sessions sont fermées ; l'opération est tracée au journal d'audit.
 * L'application doit être arrêtée si la base est PGlite (un seul processus à la fois).
 */
import { openDatabase } from "../src/server/db/client";
import { adminResetMfa } from "../src/server/services/mfa";

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("Usage : npm run user:reset-mfa -- adresse@exemple.fr");
  const handle = await openDatabase(process.env.DATABASE_URL ?? "pglite:./.data/pglite", { migrate: true });
  try {
    await adminResetMfa(handle.db, email);
    console.log(`Double authentification désactivée pour ${email} ; sessions fermées.`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
