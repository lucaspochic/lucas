/**
 * Contrôle d'une restauration : compare une base source et sa copie restaurée.
 *  - nombre de lignes de chaque table ;
 *  - compteurs de numérotation (aucun recul) ;
 *  - têtes de chaîne : journal d'audit, règlements, tickets et clôtures de caisse ;
 *  - présence des protections (déclencheurs) dans la base restaurée.
 * Utilisation : npm run restore:compare -- <url_source> <url_restauree>
 * Code de sortie 2 si une différence est trouvée.
 */
import { sql } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../src/server/db/client";

type Row = Record<string, unknown>;

async function rows(h: DbHandle, query: ReturnType<typeof sql>): Promise<Row[]> {
  const r = (await h.db.execute(query)) as unknown as { rows?: Row[] } | Row[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

async function snapshot(h: DbHandle) {
  const tables = (await rows(h, sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`)).map((r) => String(r.table_name));
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = Number((await rows(h, sql.raw(`select count(*)::int as n from "${t}"`)))[0]!.n);
  const sequences = (await rows(h, sql`select company_id, document_type, fiscal_year, last_value from document_sequences order by 1, 2, 3`)).map((r) => `${r.company_id}|${r.document_type}|${r.fiscal_year}=${r.last_value}`);
  const heads = [
    ...(await rows(h, sql`select distinct on (company_id) 'audit:' || coalesce(company_id::text, 'systeme') as k, hash as v from audit_events order by company_id, chain_seq desc`)),
    ...(await rows(h, sql`select distinct on (company_id) 'reglements:' || company_id as k, hash as v from payments order by company_id, chain_seq desc`)),
    ...(await rows(h, sql`select distinct on (register_id) 'tickets:' || register_id as k, hash as v from cash_tickets order by register_id, seq desc`)),
    ...(await rows(h, sql`select distinct on (register_id) 'clotures:' || register_id as k, hash as v from cash_closures order by register_id, seq desc`)),
  ].map((r) => `${r.k}=${r.v}`);
  const triggers = Number((await rows(h, sql`select count(*)::int as n from information_schema.triggers where trigger_schema = 'public'`))[0]!.n);
  return { counts, sequences, heads, triggers };
}

async function main() {
  const [source, restored] = process.argv.slice(2);
  if (!source || !restored) throw new Error("Usage : npm run restore:compare -- <url_source> <url_restauree>");
  const a = await openDatabase(source, { migrate: false });
  const b = await openDatabase(restored, { migrate: false });
  try {
    const [sa, sb] = [await snapshot(a), await snapshot(b)];
    const diffs: string[] = [];
    for (const t of new Set([...Object.keys(sa.counts), ...Object.keys(sb.counts)])) {
      if (sa.counts[t] !== sb.counts[t]) diffs.push(`table ${t} : ${sa.counts[t] ?? "absente"} → ${sb.counts[t] ?? "absente"}`);
    }
    for (const [label, x, y] of [["compteur", sa.sequences, sb.sequences], ["tête de chaîne", sa.heads, sb.heads]] as const) {
      const missing = x.filter((v) => !y.includes(v));
      for (const m of missing) diffs.push(`${label} différent ou absent : ${m}`);
    }
    if (sa.triggers !== sb.triggers) diffs.push(`déclencheurs : ${sa.triggers} → ${sb.triggers}`);
    console.log(JSON.stringify({ tables: Object.keys(sa.counts).length, lignes: Object.values(sa.counts).reduce((s, n) => s + n, 0), compteurs: sa.sequences.length, chaines: sa.heads.length, declencheurs: sb.triggers, differences: diffs }, null, 2));
    process.exitCode = diffs.length ? 2 : 0;
  } finally {
    await a.close();
    await b.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
