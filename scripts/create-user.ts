/**
 * Crée un compte (administration technique), par exemple le premier compte d'une
 * installation de production où l'inscription libre est désactivée.
 * Utilisation : npm run user:create -- adresse@exemple.fr "Prénom Nom"
 * Le mot de passe, aléatoire, est affiché UNE seule fois ; l'utilisateur crée ensuite son
 * entreprise à la première connexion, puis change ce mot de passe (Paramètres › Sécurité).
 */
import { randomBytes } from "node:crypto";
import { openDatabase } from "../src/server/db/client";
import { registerUser } from "../src/server/services/auth";

async function main() {
  const [email, fullName] = process.argv.slice(2);
  if (!email || !fullName) throw new Error('Usage : npm run user:create -- adresse@exemple.fr "Prénom Nom"');
  const handle = await openDatabase(process.env.DATABASE_URL ?? "pglite:./.data/pglite", { migrate: true });
  try {
    const password = randomBytes(18).toString("base64url");
    await registerUser(handle.db, { email, fullName, password });
    console.log(`Compte créé pour ${email}. Mot de passe initial : ${password}`);
    console.log("À changer dès la première connexion (Paramètres › Sécurité).");
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
