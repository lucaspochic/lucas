import { defineConfig } from "drizzle-kit";

// Utilisé uniquement pour générer les migrations SQL à partir du schéma.
// L'application des migrations passe par `npm run db:migrate` (scripts/migrate.ts),
// qui fonctionne aussi bien sur PGlite que sur PostgreSQL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  strict: true,
});
