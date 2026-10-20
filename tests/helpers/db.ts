import { openDatabase, type DbHandle } from "@/server/db/client";
import { registerUser } from "@/server/services/auth";
import { createCompany } from "@/server/services/companies";

/** Base PostgreSQL (PGlite) en mémoire, migrée, propre à chaque fichier de test. */
export async function createTestDb(): Promise<DbHandle> {
  return openDatabase("pglite:memory", { migrate: true });
}

let counter = 0;
export async function createUserWithCompany(handle: DbHandle, name = "Test") {
  counter++;
  const user = await registerUser(handle.db, {
    fullName: `${name} ${counter}`,
    email: `${name.toLowerCase()}${counter}@exemple.fr`,
    password: "motdepasse-solide-123",
  });
  const company = await createCompany(handle.db, user.id, { legalName: `${name} SAS ${counter}` });
  return { user, company, ctx: { userId: user.id, companyId: company.id, role: "owner" as const } };
}
