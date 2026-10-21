import { randomBytes } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db, Executor, Tx } from "../db/client";
import { loginAttempts, mfaChallenges, mfaRecoveryCodes, sessions, users, type User } from "../db/schema";
import { AppError } from "../errors";
import { verifyPassword } from "../security/password";
import { decryptSecret, encryptSecret } from "../security/encryption";
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from "../security/totp";
import { appendAuditEvent } from "./audit";
import { createSession, hashToken, type SessionInfo, type SessionMeta } from "./auth";

/**
 * Double authentification par application (TOTP) :
 *  - enrôlement en deux temps (secret en attente, confirmé par un premier code) ;
 *  - secret chiffré en base, codes non rejouables (dernier pas mémorisé) ;
 *  - 10 codes de secours à usage unique, stockés hachés, affichés une seule fois ;
 *  - connexion : défi court (5 tentatives au plus), échecs comptés dans la limitation des connexions.
 */

export const RECOVERY_CODE_COUNT = 10;
export const MAX_CHALLENGE_ATTEMPTS = 5;
const ISSUER = "Gestion";

const normalizeRecovery = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();
const recoveryHash = (code: string) => hashToken(`recovery:${normalizeRecovery(code)}`);

function newRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

async function storeRecoveryCodes(tx: Tx, userId: string) {
  const codes = newRecoveryCodes();
  await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await tx.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId, codeHash: recoveryHash(c) })));
  return codes;
}

async function loadUser(db: Executor, userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError("UNAUTHENTICATED", "Session invalide.");
  return user;
}

/**
 * Vérifie un code TOTP ou un code de secours pour un utilisateur dont la double
 * authentification est active ; consomme le code (pas mémorisé / code marqué utilisé).
 */
async function consumeCode(tx: Tx, user: User, code: string, now: Date): Promise<"totp" | "recovery" | null> {
  const clean = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(clean)) {
    const step = verifyTotp(decryptSecret(user.mfaSecret!), clean, now, user.mfaLastStep ?? -1);
    if (step === null) return null;
    await tx.update(users).set({ mfaLastStep: step }).where(eq(users.id, user.id));
    return "totp";
  }
  const [match] = await tx
    .update(mfaRecoveryCodes)
    .set({ usedAt: now })
    .where(and(eq(mfaRecoveryCodes.userId, user.id), eq(mfaRecoveryCodes.codeHash, recoveryHash(clean)), isNull(mfaRecoveryCodes.usedAt)))
    .returning({ id: mfaRecoveryCodes.id });
  return match ? "recovery" : null;
}

export async function mfaStatus(db: Executor, userId: string) {
  const user = await loadUser(db, userId);
  const [{ remaining } = { remaining: 0 }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
  return { enabled: !!user.mfaEnabledAt, enabledAt: user.mfaEnabledAt, pending: !!user.mfaPendingSecret, recoveryRemaining: remaining };
}

/** Étape 1 : secret en attente ; à saisir (ou scanner) dans l'application d'authentification. */
export async function startMfaEnrollment(db: Db, session: SessionInfo) {
  const user = await loadUser(db, session.userId);
  if (user.mfaEnabledAt) throw new AppError("CONFLICT", "La double authentification est déjà activée.");
  const secret = generateTotpSecret();
  await db.update(users).set({ mfaPendingSecret: encryptSecret(secret), updatedAt: new Date() }).where(eq(users.id, user.id));
  return { secret, uri: otpauthUri(ISSUER, user.email, secret) };
}

/** Étape 2 : un premier code valide active la protection ; codes de secours retournés (une seule fois). */
export async function confirmMfaEnrollment(db: Db, session: SessionInfo, code: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const user = await loadUser(tx, session.userId);
    if (user.mfaEnabledAt) throw new AppError("CONFLICT", "La double authentification est déjà activée.");
    if (!user.mfaPendingSecret) throw new AppError("VALIDATION", "Recommencez l'activation.");
    const step = verifyTotp(decryptSecret(user.mfaPendingSecret), code, now);
    if (step === null) throw new AppError("VALIDATION", "Code incorrect : vérifiez l'heure de votre téléphone et réessayez.", { code: "Code incorrect." });
    await tx
      .update(users)
      .set({ mfaSecret: user.mfaPendingSecret, mfaPendingSecret: null, mfaEnabledAt: now, mfaLastStep: step, updatedAt: now })
      .where(eq(users.id, user.id));
    const codes = await storeRecoveryCodes(tx, user.id);
    // Les autres sessions, ouvertes sans second facteur, sont fermées.
    await tx.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.id, session.sessionId)));
    await appendAuditEvent(tx, { companyId: null, actorUserId: user.id, action: "user.mfa_enabled", entityType: "user", entityId: user.id });
    return codes;
  });
}

export async function regenerateRecoveryCodes(db: Db, session: SessionInfo, code: string, opts: { now?: Date } = {}) {
  return db.transaction(async (tx) => {
    const user = await loadUser(tx, session.userId);
    if (!user.mfaEnabledAt) throw new AppError("VALIDATION", "La double authentification n'est pas activée.");
    if (!(await consumeCode(tx, user, code, opts.now ?? new Date()))) throw new AppError("VALIDATION", "Code incorrect.", { code: "Code incorrect." });
    const codes = await storeRecoveryCodes(tx, user.id);
    await appendAuditEvent(tx, { companyId: null, actorUserId: user.id, action: "user.mfa_recovery_regenerated", entityType: "user", entityId: user.id });
    return codes;
  });
}

/** Désactivation : mot de passe et code (ou code de secours) exigés. */
export async function disableMfa(db: Db, session: SessionInfo, input: { password: string; code: string }, opts: { now?: Date } = {}) {
  const user = await loadUser(db, session.userId);
  if (!user.mfaEnabledAt) throw new AppError("VALIDATION", "La double authentification n'est pas activée.");
  if (!(await verifyPassword(String(input.password ?? ""), user.passwordHash))) {
    throw new AppError("VALIDATION", "Mot de passe incorrect.", { password: "Mot de passe incorrect." });
  }
  await db.transaction(async (tx) => {
    if (!(await consumeCode(tx, user, String(input.code ?? ""), opts.now ?? new Date()))) throw new AppError("VALIDATION", "Code incorrect.", { code: "Code incorrect." });
    await tx.update(users).set({ mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastStep: null, updatedAt: new Date() }).where(eq(users.id, user.id));
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id));
    await appendAuditEvent(tx, { companyId: null, actorUserId: user.id, action: "user.mfa_disabled", entityType: "user", entityId: user.id });
  });
}

/**
 * Seconde étape de connexion. Le défi expire après 5 minutes ou 5 codes erronés ; chaque
 * échec compte aussi dans la limitation des tentatives de connexion du compte.
 */
export async function completeMfaLogin(db: Db, challengeToken: string, code: string, meta: SessionMeta = {}, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const expired = new AppError("UNAUTHENTICATED", "Session de connexion expirée : saisissez à nouveau votre mot de passe.");
  if (!challengeToken) throw expired;
  const outcome = await db.transaction(async (tx) => {
    const [challenge] = await tx
      .select()
      .from(mfaChallenges)
      .where(eq(mfaChallenges.tokenHash, hashToken(challengeToken)))
      .for("update")
      .limit(1);
    if (!challenge || challenge.expiresAt <= now || challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      if (challenge) await tx.delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id));
      return { error: expired };
    }
    const user = await loadUser(tx, challenge.userId);
    if (user.disabledAt || !user.mfaEnabledAt) {
      await tx.delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id));
      return { error: expired };
    }
    const method = await consumeCode(tx, user, code, now);
    const emailKey = hashToken(user.email.toLowerCase());
    if (!method) {
      await tx.update(mfaChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(mfaChallenges.id, challenge.id));
      await tx.insert(loginAttempts).values({ emailKey, ipAddress: meta.ip ?? null, success: false });
      const left = MAX_CHALLENGE_ATTEMPTS - challenge.attempts - 1;
      return { error: new AppError("VALIDATION", left > 0 ? `Code incorrect (${left} essai(s) restant(s)).` : "Code incorrect. Reconnectez-vous.", { code: "Code incorrect." }) };
    }
    await tx.delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id));
    await tx.insert(loginAttempts).values({ emailKey, ipAddress: meta.ip ?? null, success: true });
    return { session: await createSession(tx, user.id, meta, { mfa: method }) };
  });
  // Les échecs sont enregistrés (transaction validée) avant d'être signalés.
  if (outcome.error) throw outcome.error;
  return outcome.session!;
}

/** Réinitialisation par un administrateur technique (perte du téléphone et des codes de secours). */
export async function adminResetMfa(db: Db, email: string) {
  const normalized = email.trim().toLowerCase();
  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${normalized}`).limit(1);
  if (!user) throw new AppError("NOT_FOUND", "Aucun compte avec cette adresse.");
  await db.transaction(async (tx) => {
    await tx.update(users).set({ mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastStep: null, updatedAt: new Date() }).where(eq(users.id, user.id));
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await appendAuditEvent(tx, { companyId: null, actorUserId: null, action: "user.mfa_reset_by_admin", entityType: "user", entityId: user.id });
  });
}
