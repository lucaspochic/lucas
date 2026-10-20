/**
 * Réinitialise le mot de passe d'un utilisateur (administration technique).
 * Utilisation : npm run user:reset-password -- adresse@exemple.fr
 * Le nouveau mot de passe est affiché UNE seule fois ; à transmettre par un canal sûr.
 * L'application doit être arrêtée si la base est PGlite (un seul processus à la fois).
 */
import { openDatabase } from "../src/server/db/client";
import { adminResetPassword } from "../src/server/services/auth";

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("Usage : npm run user:reset-password -- adresse@exemple.fr");
  const handle = await openDatabase(process.env.DATABASE_URL ?? "pglite:./.data/pglite", { migrate: true });
  try {
    const password = await adminResetPassword(handle.db, email);
    console.log(`Nouveau mot de passe pour ${email} : ${password}`);
    console.log("Toutes les sessions de cet utilisateur ont été fermées.");
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
