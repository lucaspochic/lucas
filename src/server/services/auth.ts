import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Executor, Db } from "../db/client";
import { loginAttempts, memberships, sessions, users } from "../db/schema";
import { AppError } from "../errors";
import { getDummyHash, hashPassword, needsRehash, verifyPassword } from "../security/password";
import { appendAuditEvent } from "./audit";
import { changePasswordSchema, loginSchema, registerSchema } from "@/lib/schemas";

/**
 * Authentification par e-mail + mot de passe et sessions opaques.
 *  - jeton de session : 32 octets aléatoires, transmis en cookie HttpOnly ;
 *    seule son empreinte SHA-256 est stockée (une fuite de la base ne donne pas de session) ;
 *  - limitation des tentatives par e-mail et par adresse IP (fenêtre glissante) ;
 *  - message d'échec générique (pas d'énumération des comptes).
 */

export const LOGIN_WINDOW_MINUTES = 15;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 30;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function registerUser(db: Db, raw: unknown, meta: { ip?: string | null } = {}) {
  const input = registerSchema.parse(raw);
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email}`)
      .limit(1);
    if (existing.length > 0) {
      throw new AppError("CONFLICT", "Un compte existe déjà avec cette adresse e-mail.", {
        email: "Adresse déjà utilisée.",
      });
    }
    const [user] = await tx
      .insert(users)
      .values({ email: input.email, fullName: input.fullName, passwordHash })
      .returning({ id: users.id, email: users.email, fullName: users.fullName });
    await appendAuditEvent(tx, {
      companyId: null,
      actorUserId: user!.id,
      action: "user.registered",
      entityType: "user",
      entityId: user!.id,
      payload: { ip: meta.ip ?? null },
    });
    return user!;
  });
}

async function isRateLimited(db: Executor, emailKey: string, ip: string | null): Promise<boolean> {
  const since = sql`now() - make_interval(mins => ${LOGIN_WINDOW_MINUTES})`;
  const [byEmail] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.emailKey, emailKey), eq(loginAttempts.success, false), gt(loginAttempts.attemptedAt, since)));
  if ((byEmail?.n ?? 0) >= MAX_FAILURES_PER_EMAIL) return true;
  if (ip) {
    const [byIp] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.ipAddress, ip), eq(loginAttempts.success, false), gt(loginAttempts.attemptedAt, since)));
    if ((byIp?.n ?? 0) >= MAX_FAILURES_PER_IP) return true;
  }
  return false;
}

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
  ttlHours?: number;
}

export async function login(db: Db, raw: unknown, meta: SessionMeta = {}) {
  const parsed = loginSchema.safeParse(raw);
  const genericError = new AppError("UNAUTHENTICATED", "Adresse e-mail ou mot de passe incorrect.");
  if (!parsed.success) throw genericError;
  const { email, password } = parsed.data;
  const emailKey = hashToken(email); // pas d'e-mail en clair dans la table des tentatives
  const ip = meta.ip ?? null;

  if (await isRateLimited(db, emailKey, ip)) {
    throw new AppError(
      "RATE_LIMITED",
      `Trop de tentatives infructueuses. Réessayez dans ${LOGIN_WINDOW_MINUTES} minutes.`,
    );
  }

  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

  if (!user || !ok || user.disabledAt) {
    await db.insert(loginAttempts).values({ emailKey, ipAddress: ip, success: false });
    throw genericError;
  }

  return db.transaction(async (tx) => {
    await tx.insert(loginAttempts).values({ emailKey, ipAddress: ip, success: true });
    if (needsRehash(user.passwordHash)) {
      await tx.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, user.id));
    }
    const [firstMembership] = await tx
      .select({ companyId: memberships.companyId })
      .from(memberships)
      .where(eq(memberships.userId, user.id))
      .orderBy(memberships.createdAt)
      .limit(1);
    const token = randomBytes(32).toString("base64url");
    const ttlHours = meta.ttlHours ?? 12;
    const [session] = await tx
      .insert(sessions)
      .values({
        userId: user.id,
        tokenHash: hashToken(token),
        activeCompanyId: firstMembership?.companyId ?? null,
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
        ipAddress: ip,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      })
      .returning({ id: sessions.id, expiresAt: sessions.expiresAt });
    await appendAuditEvent(tx, {
      companyId: null,
      actorUserId: user.id,
      action: "user.logged_in",
      entityType: "session",
      entityId: session!.id,
      payload: { ip },
    });
    return { token, expiresAt: session!.expiresAt, userId: user.id };
  });
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  activeCompanyId: string | null;
}

/** Valide un jeton de session. Retourne null si absent, expiré, révoqué ou compte désactivé. */
export async function validateSession(db: Executor, token: string | undefined | null): Promise<SessionInfo | null> {
  if (!token || token.length > 100) return null;
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      fullName: users.fullName,
      activeCompanyId: sessions.activeCompanyId,
      expiresAt: sessions.expiresAt,
      disabledAt: users.disabledAt,
      createdAt: sessions.createdAt,
      passwordChangedAt: users.passwordChangedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);
  if (!row || row.disabledAt || row.expiresAt.getTime() <= Date.now()) return null;
  // Un changement de mot de passe invalide les sessions ouvertes auparavant.
  if (row.passwordChangedAt.getTime() > row.createdAt.getTime()) return null;
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    email: row.email,
    fullName: row.fullName,
    activeCompanyId: row.activeCompanyId,
  };
}

export async function logout(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function changePassword(db: Db, session: SessionInfo, raw: unknown) {
  const input = changePasswordSchema.parse(raw);
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new AppError("VALIDATION", "Mot de passe actuel incorrect.", { currentPassword: "Mot de passe incorrect." });
  }
  const passwordHash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, passwordChangedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await appendAuditEvent(tx, {
      companyId: null,
      actorUserId: user.id,
      action: "user.password_changed",
      entityType: "user",
      entityId: user.id,
    });
  });
}

/** Purge des sessions expirées et des tentatives anciennes (minimisation RGPD). */
export async function purgeExpiredAuthData(db: Db) {
  await db.delete(sessions).where(sql`${sessions.expiresAt} < now()`);
  await db.delete(loginAttempts).where(sql`${loginAttempts.attemptedAt} < now() - interval '30 days'`);
}
