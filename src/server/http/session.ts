import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { AppError } from "../errors";
import { can, type Permission } from "../security/permissions";
import { getDb } from "../db/client";
import { validateSession, type SessionInfo } from "../services/auth";
import { resolveCompanyContext } from "../services/companies";
import type { CompanyContext } from "../security/permissions";

/**
 * Accès à la session depuis les composants serveur, Server Actions et Route Handlers.
 * Cookie : HttpOnly, SameSite=Lax, Secure en production (préfixe __Host- : domaine et
 * chemin verrouillés). Les Server Actions Next.js vérifient en outre l'en-tête Origin
 * (protection CSRF).
 */

const isProd = process.env.APP_ENV === "production";
export const SESSION_COOKIE = isProd ? "__Host-session" : "session";

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function requestMeta() {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return { ip: forwarded || h.get("x-real-ip") || null, userAgent: h.get("user-agent") };
}

/** Session courante (mise en cache pour la durée de la requête). */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const db = await getDb();
  return validateSession(db, await readSessionToken());
});

export async function requireSession(): Promise<SessionInfo> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/** Page réservée à une permission : sinon page 404 (on ne révèle pas l'existence de la ressource). */
export async function requirePermission(permission: Permission) {
  const result = await requireCompanyContext();
  if (!can(result.ctx, permission)) notFound();
  return result;
}

/** Convertit une erreur métier « introuvable » / « interdit » en page 404. */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) notFound();
    throw err;
  }
}

/** Contexte d'entreprise vérifié en base. Redirige vers la création d'entreprise si aucune n'est active. */
export const requireCompanyContext = cache(async (): Promise<{ session: SessionInfo; ctx: CompanyContext }> => {
  const session = await requireSession();
  const db = await getDb();
  const ctx = await resolveCompanyContext(db, session.userId, session.activeCompanyId);
  if (!ctx) redirect("/onboarding");
  return { session, ctx };
});
