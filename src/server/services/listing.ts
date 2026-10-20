/**
 * Paramètres communs des listes (recherche, tri, pagination), lus depuis l'URL.
 * Toute valeur est bornée ou ramenée à une liste blanche : rien n'est injecté tel quel en SQL.
 */
export const PAGE_SIZE = 25;

export interface ListParams<S extends string> {
  q: string;
  sort: S;
  dir: "asc" | "desc";
  page: number;
  archived: boolean;
}

export function parseListParams<S extends string>(
  raw: Record<string, string | string[] | undefined>,
  allowedSorts: readonly S[],
  defaultSort: S,
): ListParams<S> {
  const get = (k: string) => {
    const v = raw[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const sort = allowedSorts.find((s) => s === get("tri")) ?? defaultSort;
  return {
    q: (get("q") ?? "").trim().slice(0, 100),
    sort,
    dir: get("ordre") === "desc" ? "desc" : "asc",
    page: Math.min(Math.max(1, Number(get("page")) || 1), 10_000),
    archived: get("archives") === "1",
  };
}

/** Échappe les jokers LIKE (% et _) d'une saisie utilisateur. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Différentiel champ par champ, valeurs converties en chaînes, pour le journal d'audit. */
export function computeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): Record<string, { from: string | null; to: string | null }> {
  const changes: Record<string, { from: string | null; to: string | null }> = {};
  for (const f of fields) {
    const from = before[f] === null || before[f] === undefined ? null : String(before[f]);
    const to = after[f] === null || after[f] === undefined ? null : String(after[f]);
    if (from !== to) changes[f] = { from, to };
  }
  return changes;
}
