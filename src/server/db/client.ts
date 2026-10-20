import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * Connexion à la base.
 *  - `pglite:<dossier>` ou `pglite:memory` : PostgreSQL embarqué (dev, démo, tests).
 *  - `postgres://…` : PostgreSQL serveur (production).
 * Le code applicatif ne dépend que du type commun `Db`.
 */

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Exécuteur de requêtes : la base ou une transaction en cours. */
export type Executor = Db | Tx;

export interface DbHandle {
  db: Db;
  kind: "pglite" | "postgres";
  close: () => Promise<void>;
}

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

export async function openDatabase(url: string, options: { migrate?: boolean } = {}): Promise<DbHandle> {
  let handle: DbHandle;
  if (url.startsWith("pglite:")) {
    const target = url.slice("pglite:".length);
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    let client: InstanceType<typeof PGlite>;
    if (target === "memory") {
      client = new PGlite();
    } else {
      const dir = path.resolve(target);
      mkdirSync(dir, { recursive: true });
      client = new PGlite(dir);
    }
    const db = drizzle(client, { schema });
    handle = { db: db as unknown as Db, kind: "pglite", close: () => client.close() };
    if (options.migrate) {
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    }
  } else if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: url, max: 10 });
    const db = drizzle(pool, { schema });
    handle = { db: db as unknown as Db, kind: "postgres", close: () => pool.end() };
    if (options.migrate) {
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    }
  } else {
    throw new Error("DATABASE_URL doit commencer par « pglite: » ou « postgres:// ».");
  }
  return handle;
}

const globalForDb = globalThis as unknown as { __dbHandle?: Promise<DbHandle> };

/**
 * Connexion partagée du processus serveur (singleton conservé entre rechargements à chaud).
 * Avec PGlite, les migrations sont appliquées automatiquement à l'ouverture, car la base
 * embarquée ne peut pas être ouverte simultanément par un second processus.
 */
export function getDb(): Promise<Db> {
  if (!globalForDb.__dbHandle) {
    const url = process.env.DATABASE_URL ?? "pglite:./.data/pglite";
    globalForDb.__dbHandle = openDatabase(url, { migrate: url.startsWith("pglite:") }).catch((err) => {
      globalForDb.__dbHandle = undefined;
      throw err;
    });
  }
  return globalForDb.__dbHandle.then((h) => h.db);
}
