/**
 * Format des numéros de documents.
 *
 * Exigence : numérotation unique, chronologique et continue, sans réutilisation
 * (CGI, art. 242 nonies A, I-7°). Une série distincte est admise par type de document
 * et par exercice, à condition que chaque série soit elle-même continue.
 *
 * L'attribution (compteur verrouillé en base) est faite dans
 * src/server/services/sequences.ts ; ce module ne fait que le formatage.
 */

export const DOCUMENT_TYPES = ["invoice", "credit_note", "quote", "deposit_invoice", "receipt", "payment"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DEFAULT_PREFIXES: Record<DocumentType, string> = {
  invoice: "FA",
  credit_note: "AV",
  quote: "DE",
  deposit_invoice: "AC",
  receipt: "TK",
  payment: "RG",
};

const PREFIX_PATTERN = /^[A-Z0-9]{1,6}$/;

export function isValidPrefix(prefix: string): boolean {
  return PREFIX_PATTERN.test(prefix);
}

/** Ex. formatDocumentNumber("FA", 2026, 42) → "FA-2026-00042". */
export function formatDocumentNumber(prefix: string, fiscalYear: number, value: number, padding = 5): string {
  if (!isValidPrefix(prefix)) throw new Error(`Préfixe de numérotation invalide : ${prefix}`);
  if (!Number.isInteger(value) || value < 1) throw new Error("La valeur de séquence doit être un entier ≥ 1.");
  return `${prefix}-${fiscalYear}-${String(value).padStart(padding, "0")}`;
}

/**
 * Exercice de rattachement d'une date calendaire (AAAA-MM-JJ, date légale en France),
 * selon le mois de début d'exercice (1 = janvier).
 * L'exercice est désigné par l'année civile de sa date de clôture.
 */
export function fiscalYearOf(isoDate: string, fiscalYearStartMonth: number): number {
  if (fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) throw new Error("Mois de début d'exercice invalide.");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`Date invalide : ${isoDate}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (fiscalYearStartMonth === 1) return year;
  return month >= fiscalYearStartMonth ? year + 1 : year;
}

/** Date calendaire du jour à Paris (AAAA-MM-JJ), indépendamment du fuseau du serveur. */
export function todayInParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(now);
}
