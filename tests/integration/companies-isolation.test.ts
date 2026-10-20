import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/server/db/client";
import {
  addMember,
  changeMemberRole,
  getCompany,
  listMembers,
  listUserCompanies,
  listVatRates,
  resolveCompanyContext,
  switchActiveCompany,
  updateCompany,
} from "@/server/services/companies";
import { listAuditEvents } from "@/server/services/audit";
import { login, registerUser, validateSession } from "@/server/services/auth";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
let a: Awaited<ReturnType<typeof createUserWithCompany>>;
let b: Awaited<ReturnType<typeof createUserWithCompany>>;

const validCompany = {
  legalName: "Atelier Martin SAS",
  siren: "732829320",
  siret: "73282932000074",
  vatNumber: "FR44732829320",
  nafCode: "6201Z",
  paymentTermsDays: 30,
  invoicePrefix: "FA",
  creditNotePrefix: "AV",
  quotePrefix: "DE",
  iban: "FR7630006000011234567890189",
};

beforeAll(async () => {
  h = await createTestDb();
  a = await createUserWithCompany(h, "Alpha");
  b = await createUserWithCompany(h, "Beta");
});
afterAll(async () => {
  await h.close();
});

describe("entreprises", () => {
  it("crée l'entreprise avec son propriétaire et les taux de TVA français", async () => {
    const rates = await listVatRates(h.db, a.ctx);
    expect(rates.map((r) => r.rate)).toEqual(["20.00", "10.00", "5.50", "2.10"]);
    expect((await listUserCompanies(h.db, a.user.id)).map((c) => c.role)).toEqual(["owner"]);
  });

  it("met à jour les paramètres et trace le différentiel", async () => {
    const updated = await updateCompany(h.db, a.ctx, validCompany);
    expect(updated.siren).toBe("732829320");
    const [event] = await listAuditEvents(h.db, a.ctx, { limit: 1 });
    expect(event?.action).toBe("company.updated");
    expect((event?.payload as { changes: Record<string, unknown> }).changes).toHaveProperty("siren");
  });

  it("rejette des identifiants incohérents", async () => {
    await expect(updateCompany(h.db, a.ctx, { ...validCompany, siret: "40483304800022" })).rejects.toThrow();
    await expect(updateCompany(h.db, a.ctx, { ...validCompany, paymentTermsDays: 90 })).rejects.toThrow();
  });
});

describe("isolation entre entreprises", () => {
  it("un utilisateur n'obtient aucun contexte sur une entreprise dont il n'est pas membre", async () => {
    expect(await resolveCompanyContext(h.db, a.user.id, b.company.id)).toBeNull();
  });

  it("ne peut pas basculer sa session sur l'entreprise d'un autre", async () => {
    await registerUser(h.db, { fullName: "Intrus", email: "intrus@exemple.fr", password: "motdepasse-intrus" });
    const { token } = await login(h.db, { email: "intrus@exemple.fr", password: "motdepasse-intrus" });
    const session = (await validateSession(h.db, token))!;
    await expect(switchActiveCompany(h.db, session.sessionId, session.userId, b.company.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("les lectures sont limitées à l'entreprise du contexte", async () => {
    const companyA = await getCompany(h.db, a.ctx);
    const companyB = await getCompany(h.db, b.ctx);
    expect(companyA.id).toBe(a.company.id);
    expect(companyB.legalName).not.toBe(companyA.legalName);
    const eventsB = await listAuditEvents(h.db, b.ctx);
    expect(eventsB.every((e) => e.action !== "company.updated")).toBe(true);
  });
});

describe("rôles", () => {
  it("un membre en lecture seule ne peut pas modifier l'entreprise", async () => {
    const reader = await registerUser(h.db, { fullName: "Lecteur", email: "lecteur@exemple.fr", password: "motdepasse-lecteur" });
    await addMember(h.db, a.ctx, { email: "lecteur@exemple.fr", role: "viewer" });
    const ctx = (await resolveCompanyContext(h.db, reader.id, a.company.id))!;
    expect(ctx.role).toBe("viewer");
    await expect(updateCompany(h.db, ctx, validCompany)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listMembers(h.db, ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addMember(h.db, ctx, { email: "intrus@exemple.fr", role: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("un administrateur ne peut pas nommer de propriétaire", async () => {
    const admin = await registerUser(h.db, { fullName: "Admin", email: "admin@exemple.fr", password: "motdepasse-admin" });
    await addMember(h.db, a.ctx, { email: "admin@exemple.fr", role: "admin" });
    const ctx = (await resolveCompanyContext(h.db, admin.id, a.company.id))!;
    await expect(changeMemberRole(h.db, ctx, admin.id, "owner")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("l'entreprise conserve toujours un propriétaire", async () => {
    await expect(changeMemberRole(h.db, a.ctx, a.user.id, "admin")).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
