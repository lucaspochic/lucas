import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { authenticate, login, registerUser, validateSession } from "@/server/services/auth";
import { adminResetMfa, completeMfaLogin, confirmMfaEnrollment, disableMfa, mfaStatus, regenerateRecoveryCodes, startMfaEnrollment } from "@/server/services/mfa";
import { totp } from "@/server/security/totp";
import { createTestDb } from "../helpers/db";

let h: DbHandle;
const PASSWORD = "motdepasse-solide-mfa";
const T0 = new Date("2026-10-21T10:00:00Z");
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

async function failure(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("L'opération aurait dû être refusée.");
}

async function enrolledUser(email: string) {
  await registerUser(h.db, { fullName: "Mfa", email, password: PASSWORD });
  const first = await login(h.db, { email, password: PASSWORD });
  const session = (await validateSession(h.db, first.token))!;
  const { secret, uri } = await startMfaEnrollment(h.db, session);
  const codes = await confirmMfaEnrollment(h.db, session, totp(secret, T0), { now: T0 });
  return { session, secret, uri, codes, firstToken: first.token };
}

async function challenge(email: string) {
  const r = await authenticate(h.db, { email, password: PASSWORD });
  if (r.kind !== "mfa") throw new Error("Défi attendu.");
  return r.challengeToken;
}

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("double authentification (TOTP)", () => {
  it("enrôlement : secret chiffré en base, premier code obligatoire, codes de secours, autres sessions fermées", async () => {
    await registerUser(h.db, { fullName: "Alice", email: "alice.mfa@exemple.fr", password: PASSWORD });
    const a = await login(h.db, { email: "alice.mfa@exemple.fr", password: PASSWORD });
    const b = await login(h.db, { email: "alice.mfa@exemple.fr", password: PASSWORD });
    const session = (await validateSession(h.db, a.token))!;
    const { secret, uri } = await startMfaEnrollment(h.db, session);
    expect(uri).toContain(`secret=${secret}`);
    const [row] = await h.db.select().from(users).where(eq(users.id, session.userId));
    expect(row!.mfaPendingSecret).toMatch(/^v1:/);
    expect(row!.mfaPendingSecret).not.toContain(secret);

    expect(await failure(confirmMfaEnrollment(h.db, session, "000000", { now: T0 }))).toContain("Code incorrect");
    const codes = await confirmMfaEnrollment(h.db, session, totp(secret, T0), { now: T0 });
    expect(codes).toHaveLength(10);
    expect(codes.every((c) => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(c))).toBe(true);
    expect(await mfaStatus(h.db, session.userId)).toMatchObject({ enabled: true, recoveryRemaining: 10 });
    expect(await validateSession(h.db, a.token)).not.toBeNull(); // session courante conservée
    expect(await validateSession(h.db, b.token)).toBeNull(); // autre session fermée
    expect(await failure(startMfaEnrollment(h.db, session))).toContain("déjà activée");
  });

  it("connexion en deux temps : mot de passe puis code ; anti-rejeu ; codes de secours à usage unique", async () => {
    const u = await enrolledUser("bob.mfa@exemple.fr");
    expect(await failure(login(h.db, { email: "bob.mfa@exemple.fr", password: PASSWORD }))).toContain("double authentification requis");

    // Le code utilisé à l'enrôlement ne peut pas resservir.
    let token = await challenge("bob.mfa@exemple.fr");
    expect(await failure(completeMfaLogin(h.db, token, totp(u.secret, T0), {}, { now: T0 }))).toContain("Code incorrect");
    const ok = await completeMfaLogin(h.db, token, totp(u.secret, later(30)), {}, { now: later(30) });
    expect(await validateSession(h.db, ok.token)).not.toBeNull();
    expect(await failure(completeMfaLogin(h.db, token, totp(u.secret, later(60)), {}, { now: later(60) }))).toContain("expirée"); // défi consommé

    token = await challenge("bob.mfa@exemple.fr");
    await completeMfaLogin(h.db, token, u.codes[0]!.toLowerCase(), {}, { now: later(90) });
    token = await challenge("bob.mfa@exemple.fr");
    expect(await failure(completeMfaLogin(h.db, token, u.codes[0]!, {}, { now: later(90) }))).toContain("Code incorrect");
    expect((await mfaStatus(h.db, u.session.userId)).recoveryRemaining).toBe(9);

    // Défi expiré.
    token = await challenge("bob.mfa@exemple.fr");
    expect(await failure(completeMfaLogin(h.db, token, totp(u.secret, later(400)), {}, { now: new Date(Date.now() + 6 * 60_000) }))).toContain("expirée");
  });

  it("5 codes erronés invalident le défi et bloquent le compte (limitation des connexions)", async () => {
    const u = await enrolledUser("carole.mfa@exemple.fr");
    const token = await challenge("carole.mfa@exemple.fr");
    for (let i = 0; i < 5; i++) {
      expect(await failure(completeMfaLogin(h.db, token, "111111", {}, { now: later(30) }))).toContain("Code incorrect");
    }
    expect(await failure(completeMfaLogin(h.db, token, totp(u.secret, later(30)), {}, { now: later(30) }))).toContain("expirée");
    expect(await failure(authenticate(h.db, { email: "carole.mfa@exemple.fr", password: PASSWORD }))).toContain("Trop de tentatives");
  });

  it("régénération des codes, désactivation (mot de passe + code), réinitialisation administrateur", async () => {
    const u = await enrolledUser("david.mfa@exemple.fr");
    const fresh = await regenerateRecoveryCodes(h.db, u.session, totp(u.secret, later(30)), { now: later(30) });
    expect(fresh).not.toEqual(u.codes);
    expect(await failure(disableMfa(h.db, u.session, { password: "faux", code: fresh[0]! }))).toContain("Mot de passe incorrect");
    expect(await failure(disableMfa(h.db, u.session, { password: PASSWORD, code: u.codes[0]! }))).toContain("Code incorrect"); // anciens codes révoqués
    await disableMfa(h.db, u.session, { password: PASSWORD, code: fresh[1]! });
    expect(await mfaStatus(h.db, u.session.userId)).toMatchObject({ enabled: false, recoveryRemaining: 0 });
    expect((await authenticate(h.db, { email: "david.mfa@exemple.fr", password: PASSWORD })).kind).toBe("session");

    const e = await enrolledUser("eve.mfa@exemple.fr");
    await adminResetMfa(h.db, "EVE.mfa@exemple.fr");
    expect(await validateSession(h.db, e.firstToken)).toBeNull();
    expect((await authenticate(h.db, { email: "eve.mfa@exemple.fr", password: PASSWORD })).kind).toBe("session");
  });
});
