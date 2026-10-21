import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Signature électronique Ed25519 des clôtures et archives de caisse (BOFiP §130 :
 * « procédé fiable… signature électronique »).
 *
 * Clé privée :
 *  - production : variable d'environnement CASH_SIGNING_KEY (PEM PKCS#8), obligatoire ;
 *  - développement : générée une fois dans .data/keys/cash-signing.pem (non versionné) ;
 *  - tests : clé éphémère en mémoire.
 * La clé publique est jointe à chaque archive ; `keyId` (empreinte de la clé publique)
 * est enregistré avec chaque signature, ce qui permet une rotation des clés.
 */

interface SigningKey {
  privateKey: KeyObject;
  publicKeyPem: string;
  keyId: string;
}

let cached: SigningKey | undefined;

function fromPrivate(privateKey: KeyObject): SigningKey {
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const der = publicKey.export({ type: "spki", format: "der" });
  return { privateKey, publicKeyPem, keyId: createHash("sha256").update(der).digest("hex").slice(0, 16) };
}

export function getSigningKey(): SigningKey {
  if (cached) return cached;
  const fromEnv = process.env.CASH_SIGNING_KEY;
  if (fromEnv) {
    cached = fromPrivate(createPrivateKey(fromEnv.replace(/\\n/g, "\n")));
  } else if (process.env.VITEST) {
    cached = fromPrivate(generateKeyPairSync("ed25519").privateKey);
  } else if (process.env.APP_ENV === "production") {
    throw new Error("CASH_SIGNING_KEY est obligatoire en production (clé Ed25519 PKCS#8).");
  } else {
    const file = path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "keys", "cash-signing.pem");
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true });
      const { privateKey } = generateKeyPairSync("ed25519");
      writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    }
    cached = fromPrivate(createPrivateKey(readFileSync(file)));
  }
  return cached;
}

export function signText(text: string): { signature: string; keyId: string } {
  const key = getSigningKey();
  return { signature: sign(null, Buffer.from(text, "utf8"), key.privateKey).toString("base64"), keyId: key.keyId };
}

/** Vérifie une signature avec la clé courante, ou avec une clé publique fournie (archives). */
export function verifyText(text: string, signature: string, publicKeyPem?: string): boolean {
  const key = publicKeyPem ? createPublicKey(publicKeyPem) : createPublicKey(getSigningKey().privateKey);
  try {
    return verify(null, Buffer.from(text, "utf8"), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
