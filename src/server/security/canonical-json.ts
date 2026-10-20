/**
 * Sérialisation JSON canonique : clés triées récursivement, pas d'espace.
 * Garantit qu'un même contenu produit toujours la même empreinte, y compris après un
 * aller-retour par le type jsonb de PostgreSQL (qui réordonne les clés).
 * Les nombres non entiers sont refusés : les montants doivent être des chaînes décimales.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError("canonicalJson : seuls les entiers sûrs sont admis ; utilisez une chaîne décimale.");
      }
      return String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson : type non sérialisable (${typeof value}).`);
  }
}
