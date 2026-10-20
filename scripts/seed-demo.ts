/**
 * Données de démonstration — UNIQUEMENT hors production.
 * Crée un compte de démonstration et une entreprise marquée is_demo (bandeau visible
 * dans l'interface). Refuse de s'exécuter si APP_ENV=production.
 *
 * Les identifiants créés sont écrits dans .data/demo-credentials.txt (non versionné).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { openDatabase } from "../src/server/db/client";
import { registerUser } from "../src/server/services/auth";
import { createCompany, updateCompany } from "../src/server/services/companies";

async function main() {
  if (process.env.APP_ENV === "production") {
    throw new Error("Refus : les données de démonstration ne doivent pas être chargées en production.");
  }
  const handle = await openDatabase(process.env.DATABASE_URL ?? "pglite:./.data/pglite", { migrate: true });
  try {
    const email = "demo@exemple.test";
    const password = `demo-${randomBytes(6).toString("hex")}`;
    const user = await registerUser(handle.db, { fullName: "Camille Démo", email, password });
    const company = await createCompany(handle.db, user.id, { legalName: "Atelier Démo SAS", siren: "732829320" }, { isDemo: true });
    await updateCompany(handle.db, { userId: user.id, companyId: company.id, role: "owner" }, {
      legalName: "Atelier Démo SAS",
      tradeName: "Atelier Démo",
      legalForm: "SAS",
      siren: "732829320",
      siret: "73282932000074",
      vatNumber: "FR44732829320",
      nafCode: "6201Z",
      shareCapital: "10000.00",
      rcsCity: "RCS Lyon",
      addressLine1: "12 rue de l'Exemple",
      postalCode: "69002",
      city: "Lyon",
      country: "FR",
      paymentTermsDays: 30,
      invoicePrefix: "FA",
      creditNotePrefix: "AV",
      quotePrefix: "DE",
    });
    mkdirSync(".data", { recursive: true });
    writeFileSync(".data/demo-credentials.txt", `Compte de démonstration\nE-mail : ${email}\nMot de passe : ${password}\n`);
    console.log("Données de démonstration créées. Identifiants : .data/demo-credentials.txt");
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
