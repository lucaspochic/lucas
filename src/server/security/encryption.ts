import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Chiffrement applicatif des secrets stockés en base (secrets TOTP) : AES-256-GCM.
 * Une fuite de la base seule ne permet pas de générer les codes de double authentification.
 *
 * Clé (32 octets, base64) :
 *  - production : variable d'environnement APP_ENCRYPTION_KEY, obligatoire ;
 *  - développement : générée une fois dans .data/keys/app-encryption.key (non versionné) ;
 *  - tests : clé éphémère en mémoire.
 * Format chiffré : « v1:<iv>:<tag>:<données> » (base64url).
 */

let cached: Buffer | undefined;

function key(): Buffer {
  if (cached) return cached;
  const fromEnv = process.env.APP_ENCRYPTION_KEY;
  if (fromEnv) {
    cached = Buffer.from(fromEnv, "base64");
  } else if (process.env.VITEST) {
    cached = randomBytes(32);
  } else if (process.env.APP_ENV === "production") {
    throw new Error("APP_ENCRYPTION_KEY est obligatoire en production (32 octets en base64).");
  } else {
    const file = path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "keys", "app-encryption.key");
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
    }
    cached = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  }
  if (cached.length !== 32) throw new Error("APP_ENCRYPTION_KEY doit faire 32 octets (base64).");
  return cached;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
}

export function decryptSecret(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Secret chiffré illisible.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
