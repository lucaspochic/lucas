import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "@/server/security/password";
import { can, ROLE_PERMISSIONS, PERMISSIONS } from "@/server/security/permissions";

describe("mots de passe", () => {
  it("hache avec un sel unique et vérifie", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$\d+\$8\$1\$/);
    expect(await verifyPassword("correct horse battery staple", a)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", a)).toBe(false);
  });

  it("refuse un hash mal formé", async () => {
    expect(await verifyPassword("x", "md5$abc")).toBe(false);
  });

  it("signale les hash à renforcer", () => {
    expect(needsRehash("scrypt$10$8$1$a$b")).toBe(true);
  });
});

describe("matrice des permissions", () => {
  it("le propriétaire a toutes les permissions", () => {
    for (const p of PERMISSIONS) expect(can({ role: "owner" }, p)).toBe(true);
  });

  it("la lecture seule ne peut rien modifier", () => {
    for (const p of ROLE_PERMISSIONS.viewer) expect(p.endsWith(".read")).toBe(true);
  });

  it("le caissier n'accède ni à la comptabilité ni aux paramètres", () => {
    expect(can({ role: "cashier" }, "cash.operate")).toBe(true);
    expect(can({ role: "cashier" }, "accounting.read")).toBe(false);
    expect(can({ role: "cashier" }, "company.update")).toBe(false);
    expect(can({ role: "cashier" }, "cash.close")).toBe(false);
  });

  it("seul le propriétaire et le comptable clôturent la comptabilité", () => {
    const closers = Object.entries(ROLE_PERMISSIONS)
      .filter(([, perms]) => perms.has("accounting.close"))
      .map(([role]) => role)
      .sort();
    expect(closers).toEqual(["accountant", "owner"]);
  });
});
