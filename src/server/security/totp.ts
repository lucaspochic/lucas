import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Mots de passe à usage unique basés sur le temps (TOTP, RFC 6238 sur HOTP, RFC 4226) :
 * HMAC-SHA1, pas de 30 secondes, 6 chiffres — paramètres par défaut compris par les
 * applications d'authentification courantes. Fonctions pures, sans dépendance.
 */

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Clé base32 invalide.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Secret de 160 bits (recommandation de la RFC 4226), encodé en base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(bin).padStart(TOTP_DIGITS, "0");
}

export const timeStep = (now: Date) => Math.floor(now.getTime() / 1000 / TOTP_PERIOD);

export function totp(secret: string, now: Date = new Date()): string {
  return hotp(secret, timeStep(now));
}

/**
 * Vérifie un code avec une tolérance d'un pas avant / après (décalage d'horloge).
 * Retourne le pas reconnu, ou null. `afterStep` : dernier pas déjà utilisé (anti-rejeu).
 */
export function verifyTotp(secret: string, code: string, now: Date = new Date(), afterStep = -1): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const current = timeStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= afterStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return null;
}

export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${params}`;
}
