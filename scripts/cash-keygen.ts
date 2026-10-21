/**
 * Génère les secrets de production :
 *  - clé Ed25519 de signature des clôtures et archives de caisse ;
 *  - clé AES-256 de chiffrement des secrets de double authentification.
 * Affiche la valeur à placer dans GESTION_CASH_SIGNING_KEY (une ligne, « \n » échappés)
 * et la clé publique à conserver (vérification des archives, même après rotation).
 * Utilisation : npm run cash:keygen
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

const { privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = createPublicKey(privateKey);
const keyId = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);

console.log("# Clé privée — à placer dans le fichier --env-file, jamais dans le dépôt :");
console.log(`GESTION_CASH_SIGNING_KEY="${pem.trim().replace(/\n/g, "\\n")}"`);
console.log(`\n# Identifiant de clé : ${keyId}`);
console.log("# Clé publique — à conserver avec la documentation de l'installation :");
console.log(publicKey.export({ type: "spki", format: "pem" }).toString());

console.log("# Clé de chiffrement des secrets de double authentification (à sauvegarder : sa perte oblige à réenrôler chaque utilisateur) :");
console.log(`GESTION_APP_ENCRYPTION_KEY="${randomBytes(32).toString("base64")}"`);
