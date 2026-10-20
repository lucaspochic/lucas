/**
 * CSV (RFC 4180) adapté aux tableurs français :
 *  - séparateur « ; » par défaut (Excel FR), détection automatique « ; » / « , » / tabulation à l'import ;
 *  - export en UTF-8 avec BOM (accents corrects à l'ouverture dans Excel) ;
 *  - protection contre l'injection de formules à l'export (cellules commençant par = + - @ préfixées
 *    d'une apostrophe, recommandation OWASP « CSV Injection »).
 */

export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 5000;

export class CsvError extends Error {}

export function detectSeparator(headerLine: string): string {
  const counts = [";", ",", "\t"].map((sep) => [sep, headerLine.split(sep).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ";";
}

/** Analyse un texte CSV complet. Gère guillemets, guillemets doublés et retours à la ligne dans les champs. */
export function parseCsv(input: string, separator?: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const firstLineEnd = text.search(/\r?\n/);
  const sep = separator ?? detectSeparator(firstLineEnd === -1 ? text : text.slice(0, firstLineEnd));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      i++;
    } else if (c === sep) {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (inQuotes) throw new CsvError("Fichier CSV invalide : guillemet non fermé.");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Lignes entièrement vides ignorées.
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Transforme un CSV avec en-tête en objets ; les en-têtes sont normalisés (minuscules, sans accents ni espaces). */
export function csvToRecords(input: string): { headers: string[]; records: Record<string, string>[] } {
  const rows = parseCsv(input);
  if (rows.length === 0) throw new CsvError("Le fichier est vide.");
  const headers = rows[0]!.map(normalizeHeader);
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h) rec[h] = (r[idx] ?? "").trim();
    });
    return rec;
  });
  return { headers, records };
}

export function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: unknown, separator = ";"): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA_PREFIX.test(s)) s = `'${s}`;
  if (s.includes(separator) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[], separator = ";"): string {
  const lines = [headers, ...rows].map((r) => r.map((v) => escapeCsvCell(v, separator)).join(separator));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Montant décimal saisi à la française (« 1 234,50 ») ou à l'anglaise (« 1234.50 ») → « 1234.50 ». */
export function parseFrenchDecimal(value: string): string | null {
  const v = value.replace(/[\s  €]/g, "");
  if (v === "") return null;
  const normalized = v.includes(",") ? v.replace(/\./g, "").replace(",", ".") : v;
  return /^-?\d+(\.\d+)?$/.test(normalized) ? normalized : null;
}

/** Décimal → format français pour l'export (« 1234,50 »). */
export function toFrenchDecimal(value: string | null): string {
  return value === null ? "" : value.replace(".", ",");
}
