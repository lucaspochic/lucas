/**
 * Validation des identifiants d'entreprise français.
 *  - SIREN : 9 chiffres, clé de Luhn.
 *  - SIRET : 14 chiffres = SIREN + NIC, clé de Luhn
 *    (exception historique de La Poste, SIREN 356000000 : somme des chiffres multiple de 5).
 *  - TVA intracommunautaire FR : "FR" + clé (2 caractères) + SIREN ;
 *    clé numérique = (12 + 3 × (SIREN mod 97)) mod 97.
 *  - Code APE/NAF (rév. 2) : 4 chiffres + 1 lettre, ex. « 6201Z ».
 */

const LA_POSTE_SIREN = "356000000";

export function normalizeDigits(value: string): string {
  return value.replace(/[\s.\-]/g, "");
}

function luhnValid(digits: string): boolean {
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0;
}

export function isValidSiren(value: string): boolean {
  const v = normalizeDigits(value);
  return /^\d{9}$/.test(v) && luhnValid(v);
}

export function isValidSiret(value: string): boolean {
  const v = normalizeDigits(value);
  if (!/^\d{14}$/.test(v)) return false;
  if (v.startsWith(LA_POSTE_SIREN)) {
    const s = [...v].reduce((acc, c) => acc + Number(c), 0);
    return s % 5 === 0;
  }
  return luhnValid(v);
}

export function frenchVatKey(siren: string): string {
  const n = Number(normalizeDigits(siren));
  return String((12 + 3 * (n % 97)) % 97).padStart(2, "0");
}

export function frenchVatNumberFromSiren(siren: string): string {
  const s = normalizeDigits(siren);
  return `FR${frenchVatKey(s)}${s}`;
}

/** Vérifie la cohérence d'un numéro de TVA français (clé numérique uniquement). */
export function isValidFrenchVatNumber(value: string): boolean {
  const v = value.replace(/\s/g, "").toUpperCase();
  const m = /^FR(\d{2})(\d{9})$/.exec(v);
  if (!m) return false;
  const [, key, siren] = m;
  return isValidSiren(siren!) && frenchVatKey(siren!) === key;
}

export function isValidNafCode(value: string): boolean {
  return /^\d{2}\.?\d{2}[A-Z]$/.test(value.trim().toUpperCase());
}

/** Contrôle de structure d'un IBAN (ISO 13616, mod 97). */
export function isValidIban(value: string): boolean {
  const v = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1;
}
