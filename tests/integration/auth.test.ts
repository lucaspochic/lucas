import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sessions } from "@/server/db/schema";
import type { DbHandle } from "@/server/db/client";
import {
  adminResetPassword,
  changePassword,
  login,
  logout,
  MAX_FAILURES_PER_EMAIL,
  registerUser,
  validateSession,
} from "@/server/services/auth";
import { verifyAuditChain } from "@/server/services/audit";
import { createTestDb } from "../helpers/db";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

const PASSWORD = "un-mot-de-passe-long";

describe("authentification", () => {
  it("crée un compte, ouvre et ferme une session", async () => {
    await registerUser(h.db, { fullName: "Alice Martin", email: "Alice@Exemple.fr", password: PASSWORD });
    const { token } = await login(h.db, { email: "alice@exemple.fr", password: PASSWORD });
    const session = await validateSession(h.db, token);
    expect(session?.email).toBe("alice@exemple.fr");
    await logout(h.db, token);
    expect(await validateSession(h.db, token)).toBeNull();
  });

  it("refuse un e-mail déjà utilisé (insensible à la casse)", async () => {
    await expect(
      registerUser(h.db, { fullName: "Alice Bis", email: "ALICE@exemple.fr", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuse un mot de passe trop court", async () => {
    await expect(registerUser(h.db, { fullName: "Bob", email: "bob@exemple.fr", password: "court" })).rejects.toThrow();
  });

  it("renvoie le même message que le compte existe ou non", async () => {
    const a = await login(h.db, { email: "alice@exemple.fr", password: "mauvais-mot-de-passe" }).catch((e) => e);
    const b = await login(h.db, { email: "inconnu@exemple.fr", password: "mauvais-mot-de-passe" }).catch((e) => e);
    expect(a.message).toBe(b.message);
    expect(a.code).toBe("UNAUTHENTICATED");
  });

  it("bloque après trop d'échecs, même avec le bon mot de passe", async () => {
    await registerUser(h.db, { fullName: "Carole", email: "carole@exemple.fr", password: PASSWORD });
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
      await login(h.db, { email: "carole@exemple.fr", password: "faux-mot-de-passe" }).catch(() => undefined);
    }
    await expect(login(h.db, { email: "carole@exemple.fr", password: PASSWORD })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("ne stocke que l'empreinte du jeton de session", async () => {
    const { token, userId } = await login(h.db, { email: "alice@exemple.fr", password: PASSWORD });
    const rows = await h.db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(rows.every((r) => r.tokenHash !== token && r.tokenHash.length === 64)).toBe(true);
  });

  it("refuse une session expirée", async () => {
    const { token, userId } = await login(h.db, { email: "alice@exemple.fr", password: PASSWORD });
    await h.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, userId));
    expect(await validateSession(h.db, token)).toBeNull();
  });

  it("le changement de mot de passe révoque toutes les sessions", async () => {
    const { token } = await login(h.db, { email: "alice@exemple.fr", password: PASSWORD });
    const session = (await validateSession(h.db, token))!;
    await changePassword(h.db, session, {
      currentPassword: PASSWORD,
      newPassword: "nouveau-mot-de-passe-long",
      confirmPassword: "nouveau-mot-de-passe-long",
    });
    expect(await validateSession(h.db, token)).toBeNull();
    await expect(login(h.db, { email: "alice@exemple.fr", password: PASSWORD })).rejects.toThrow();
    await expect(login(h.db, { email: "alice@exemple.fr", password: "nouveau-mot-de-passe-long" })).resolves.toBeTruthy();
  });

  it("la réinitialisation administrateur change le mot de passe et ferme les sessions", async () => {
    const { token } = await login(h.db, { email: "alice@exemple.fr", password: "nouveau-mot-de-passe-long" });
    const fresh = await adminResetPassword(h.db, "ALICE@exemple.fr");
    expect(fresh.length).toBeGreaterThanOrEqual(24);
    expect(await validateSession(h.db, token)).toBeNull();
    await expect(login(h.db, { email: "alice@exemple.fr", password: "nouveau-mot-de-passe-long" })).rejects.toThrow();
    await expect(login(h.db, { email: "alice@exemple.fr", password: fresh })).resolves.toBeTruthy();
    await expect(adminResetPassword(h.db, "personne@exemple.fr")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("trace les événements d'authentification dans une chaîne valide", async () => {
    const result = await verifyAuditChain(h.db, null);
    expect(result.valid).toBe(true);
    expect(result.eventsChecked).toBeGreaterThan(5);
  });
});
