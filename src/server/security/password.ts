import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Hachage des mots de passe : scrypt (RFC 7914), sel aléatoire de 16 octets.
 * Paramètres par défaut N=2^17, r=8, p=1 (recommandation OWASP Password Storage).
 * Les paramètres sont stockés dans le hash : ils peuvent être renforcés sans migration,
 * needsRehash() signalant les hash à recalculer lors de la prochaine connexion.
 *
 * Format : scrypt$<logN>$<r>$<p>$<sel base64>$<clé base64>
 */

const KEY_LENGTH = 64;
const DEFAULT_LOG_N = Number(process.env.PASSWORD_SCRYPT_LOG_N ?? 17);
const R = 8;
const P = 1;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

function scrypt(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** logN;
  const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length > PASSWORD_MAX_LENGTH) throw new Error("Mot de passe trop long.");
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, DEFAULT_LOG_N, R, P);
  return ["scrypt", DEFAULT_LOG_N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, logN, r, p, saltB64, keyB64] = parts;
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  const expected = Buffer.from(keyB64!, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64!, "base64"), Number(logN), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function needsRehash(stored: string): boolean {
  const [, logN] = stored.split("$");
  return Number(logN) < DEFAULT_LOG_N;
}

/** Hash factice utilisé quand l'utilisateur n'existe pas : temps de réponse homogène. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}
