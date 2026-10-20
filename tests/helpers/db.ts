import { openDatabase, type DbHandle } from "@/server/db/client";
import { registerUser } from "@/server/services/auth";
import { createCompany } from "@/server/services/companies";

/**
 * Base de test migrée, propre à chaque fichier de test :
 *  - par défaut PGlite en mémoire ;
 *  - si TEST_POSTGRES_URL est défini (ex. postgres://user:mdp@localhost:55432/postgres),
 *    une base PostgreSQL serveur jetable est créée puis supprimée : les verrous et la
 *    concurrence sont alors réellement éprouvés (pool de connexions).
 */
export async function createTestDb(): Promise<DbHandle> {
  const adminUrl = process.env.TEST_POSTGRES_URL;
  if (!adminUrl) return openDatabase("pglite:memory", { migrate: true });

  const { Client } = await import("pg");
  const name = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const handle = await openDatabase(url.toString(), { migrate: true });
  return {
    ...handle,
    close: async () => {
      await handle.close();
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
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
