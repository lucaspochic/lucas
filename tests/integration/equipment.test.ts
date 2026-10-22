import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { companies } from "@/server/db/schema";
import { registerUser } from "@/server/services/auth";
import { createCompany, getCompany, listVatRates, updateCompany } from "@/server/services/companies";
import { createThirdParty, setThirdPartyArchived } from "@/server/services/third-parties";
import { createDraft, issueDocument } from "@/server/services/sales";
import {
  createEquipment,
  equipmentHistory,
  getEquipment,
  invoicesOfParty,
  listEquipment,
  listEquipmentOfDocument,
  listEquipmentOfParty,
  parcSummary,
  setEquipmentArchived,
  updateEquipment,
} from "@/server/services/equipment";
import { navigationModules } from "@/server/services/modules";
import { addAttachment, listAttachments } from "@/server/services/attachments";
import { featuredModules, suggestedModules } from "@/lib/activities";
import { companySchema, createCompanySchema, normalizeRegistration } from "@/lib/schemas";
import type { CompanyContext } from "@/server/security/permissions";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
const NOW = { now: new Date("2026-10-21T10:00:00Z") };
const dir = mkdtempSync(path.join(tmpdir(), "parc-test-"));
process.env.ATTACHMENTS_DIR = dir;

async function failure(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} | ${e.cause?.message ?? ""}`;
  }
  throw new Error("L'opération aurait dû être refusée.");
}

const COMPANY = {
  legalName: "Tracteurs du Val SAS",
  siren: "732829320",
  vatNumber: "FR44732829320",
  addressLine1: "1 route des champs",
  postalCode: "69001",
  city: "Lyon",
  paymentTermsDays: 30,
  latePenaltyText: "Pénalités.",
  invoicePrefix: "FA",
  creditNotePrefix: "AV",
  quotePrefix: "DE",
};

async function setup(name: string) {
  const c = await createUserWithCompany(h, name);
  await updateCompany(h.db, c.ctx, { ...COMPANY, activities: ["materiel_agricole_tp"], modules: ["parc"] });
  const r20 = (await listVatRates(h.db, c.ctx)).find((r) => r.rate === "20.00")!.id;
  const farmer = await createThirdParty(h.db, c.ctx, { partyType: "business", name: "GAEC des Prés", siren: "552100554", billingLine1: "Lieu-dit Les Prés", billingPostalCode: "01000", billingCity: "Bourg-en-Bresse" });
  const other = await createThirdParty(h.db, c.ctx, { partyType: "individual", name: "Paul Voisin", billingLine1: "3 chemin", billingPostalCode: "01000", billingCity: "Bourg-en-Bresse" });
  const invoice = await issueDocument(
    h.db,
    c.ctx,
    (
      await createDraft(h.db, c.ctx, "invoice", {
        thirdPartyId: farmer.id,
        lines: [{ description: "Tracteur John Deere 6R 150", kind: "good", quantity: "1", unit: "unité", unitPriceExclTax: "120000", vatRateId: r20 }],
      })
    ).id,
    NOW,
  );
  return { ...c, farmer, other, invoice };
}

const tractor = (thirdPartyId: string, extra: Record<string, unknown> = {}) => ({
  thirdPartyId,
  category: "agricultural",
  brand: "John Deere",
  model: "6R 150",
  serialNumber: "1rw6150 xkp123456",
  year: "2025",
  meterValue: "12",
  meterUnit: "h",
  ...extra,
});

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("domaines d'activité et agencement", () => {
  it("les activités suggèrent les modules ; listes normalisées (idempotentes)", () => {
    expect(suggestedModules(["vente_vehicules", "restauration"])).toEqual(["caisse", "parc"]);
    expect(suggestedModules(["services"])).toEqual([]);
    expect(featuredModules(["commerce_detail"], ["caisse", "parc"])).toEqual(["caisse"]);
    const once = createCompanySchema.parse({ legalName: "Garage SAS", activities: ["reparation_entretien", "vente_vehicules", "vente_vehicules"] });
    expect(once.activities).toEqual(["vente_vehicules", "reparation_entretien"]);
    expect(createCompanySchema.parse(once).activities).toEqual(once.activities);
    // Formulaire sans case cochée (React Hook Form renvoie false) ou une seule case (chaîne).
    expect(createCompanySchema.parse({ legalName: "Garage SAS", activities: false }).activities).toEqual([]);
    expect(createCompanySchema.parse({ legalName: "Garage SAS", activities: "negoce" }).activities).toEqual(["negoce"]);
    expect(createCompanySchema.safeParse({ legalName: "Garage SAS", activities: ["inconnue"] }).success).toBe(false);
    expect(companySchema.safeParse({ ...COMPANY, modules: ["compta-magique"] }).success).toBe(false);
  });

  it("création d'entreprise : activités enregistrées, modules suggérés, menu adapté", async () => {
    const user = await registerUser(h.db, { fullName: "Garagiste", email: "garage@exemple.fr", password: "motdepasse-solide-123" });
    const company = await createCompany(h.db, user.id, { legalName: "Garage Central", activities: ["vente_vehicules", "commerce_detail"] });
    expect(company.activities).toEqual(["vente_vehicules", "commerce_detail"]);
    expect(company.modules).toEqual(["caisse", "parc"]);
    expect(await navigationModules(h.db, company)).toEqual({ visible: ["caisse", "parc"], featured: ["caisse", "parc"] });

    const plain = await createCompany(h.db, user.id, { legalName: "Conseil SARL", activities: ["services"] });
    expect(plain.modules).toEqual([]);
    expect(await navigationModules(h.db, plain)).toEqual({ visible: [], featured: [] });

    // Module activé à la main sans activité qui le suggère : visible, mais pas mis en avant.
    const ctx: CompanyContext = { userId: user.id, companyId: plain.id, role: "owner" };
    await updateCompany(h.db, ctx, { ...COMPANY, legalName: "Conseil SARL", activities: ["services"], modules: ["parc"] });
    expect(await navigationModules(h.db, await getCompany(h.db, ctx))).toEqual({ visible: ["parc"], featured: [] });
  });

  it("un module désactivé qui contient des données reste visible", async () => {
    const c = await setup("Retrait");
    await createEquipment(h.db, c.ctx, tractor(c.farmer.id));
    await updateCompany(h.db, c.ctx, { ...COMPANY, activities: [], modules: [] });
    const company = await getCompany(h.db, c.ctx);
    expect(company.modules).toEqual([]);
    expect((await navigationModules(h.db, company)).visible).toEqual(["parc"]);
  });

  it("la base refuse une activité ou un module inconnus", async () => {
    const c = await createUserWithCompany(h, "Contrainte");
    expect(await failure(h.db.update(companies).set({ activities: ["piraterie"] }).where(eq(companies.id, c.company.id)))).toContain("companies_activities_ck");
    expect(await failure(h.db.update(companies).set({ modules: ["x"] }).where(eq(companies.id, c.company.id)))).toContain("companies_modules_ck");
  });
});

describe("parc matériel", () => {
  it("enregistrement rattaché au client et à la facture, identifiants normalisés", async () => {
    const c = await setup("Parc");
    const item = await createEquipment(
      h.db,
      c.ctx,
      tractor(c.farmer.id, { registration: "ab 123 cd", salesDocumentId: c.invoice.id, soldOn: "2026-10-21", warrantyEndsOn: "2026-11-30" }),
    );
    expect(item).toMatchObject({ serialNumber: "1RW6150XKP123456", registration: "AB-123-CD", year: 2025, meterValue: 12, meterUnit: "h" });
    expect(normalizeRegistration("AB-123-CD")).toBe("AB-123-CD");

    const detail = await getEquipment(h.db, c.ctx, item.id);
    expect(detail).toMatchObject({ partyName: "GAEC des Prés", invoiceNumber: c.invoice.number });
    expect((await listEquipmentOfParty(h.db, c.ctx, c.farmer.id)).map((e) => e.id)).toEqual([item.id]);
    expect((await listEquipmentOfDocument(h.db, c.ctx, c.invoice.id)).map((e) => e.id)).toEqual([item.id]);
    expect((await invoicesOfParty(h.db, c.ctx, c.farmer.id)).map((i) => i.id)).toEqual([c.invoice.id]);
    expect(await invoicesOfParty(h.db, c.ctx, c.other.id)).toEqual([]);

    // Recherche : immatriculation saisie sans tirets, nom du client, n° de série partiel.
    const search = async (q: string) =>
      (await listEquipment(h.db, c.ctx, { q, sort: "client", dir: "asc", page: 1, archived: false })).rows.map((r) => r.id);
    expect(await search("AB123CD")).toEqual([item.id]);
    expect(await search("gaec")).toEqual([item.id]);
    expect(await search("xkp123")).toEqual([item.id]);
    expect(await search("Renault")).toEqual([]);

    expect(await parcSummary(h.db, c.ctx, "2026-10-21")).toEqual({ active: 1, warrantySoon: 1 });
    expect(await parcSummary(h.db, c.ctx, "2026-12-01")).toEqual({ active: 1, warrantySoon: 0 });
  });

  it("contrôles : n° de série unique, VIN plausible, facture émise au même client, compteur avec unité", async () => {
    const c = await setup("Controles");
    await createEquipment(h.db, c.ctx, tractor(c.farmer.id));
    expect(await failure(createEquipment(h.db, c.ctx, tractor(c.other.id, { serialNumber: "1RW6150XKP123456" })))).toContain("déjà enregistré");
    expect(await failure(createEquipment(h.db, c.ctx, tractor(c.other.id, { category: "vehicle", serialNumber: "VF1RJA00O12345678" })))).toContain("VIN invalide");
    expect(await failure(createEquipment(h.db, c.ctx, tractor(c.other.id, { serialNumber: "", salesDocumentId: c.invoice.id })))).toContain(
      "n'est pas adressée à ce client",
    );
    expect(await failure(createEquipment(h.db, c.ctx, tractor(c.farmer.id, { serialNumber: "", meterUnit: "" })))).toContain("unité du compteur");
    expect(await failure(createEquipment(h.db, c.ctx, tractor(c.farmer.id, { serialNumber: "", soldOn: "2026-10-21", warrantyEndsOn: "2026-01-01" })))).toContain(
      "garantie ne peut pas finir avant la vente",
    );

    // Un brouillon de facture ne peut pas servir de pièce de vente.
    const r20 = (await listVatRates(h.db, c.ctx)).find((r) => r.rate === "20.00")!.id;
    const draft = await createDraft(h.db, c.ctx, "invoice", {
      thirdPartyId: c.farmer.id,
      lines: [{ description: "Herse", kind: "good", quantity: "1", unit: "unité", unitPriceExclTax: "5000", vatRateId: r20 }],
    });
    expect(await failure(createEquipment(h.db, c.ctx, tractor(c.farmer.id, { serialNumber: "", salesDocumentId: draft.id })))).toContain("facture émise");

    // Client archivé : pas de nouveau matériel.
    await setThirdPartyArchived(h.db, c.ctx, c.other.id, true);
    expect(await failure(createEquipment(h.db, c.ctx, tractor(c.other.id, { serialNumber: "" })))).toContain("client actif");
  });

  it("revente à un autre client : propriétaire changé et tracé ; archivage ; historique", async () => {
    const c = await setup("Revente");
    const item = await createEquipment(h.db, c.ctx, tractor(c.farmer.id, { salesDocumentId: c.invoice.id }));
    // La facture d'origine n'est pas adressée au nouveau propriétaire : il faut la détacher.
    expect(await failure(updateEquipment(h.db, c.ctx, item.id, tractor(c.other.id, { salesDocumentId: c.invoice.id })))).toContain("n'est pas adressée");
    await updateEquipment(h.db, c.ctx, item.id, tractor(c.other.id, { meterValue: "850" }));
    expect((await getEquipment(h.db, c.ctx, item.id)).partyName).toBe("Paul Voisin");
    expect(await listEquipmentOfParty(h.db, c.ctx, c.farmer.id)).toEqual([]);

    await setEquipmentArchived(h.db, c.ctx, item.id, true);
    expect(await failure(updateEquipment(h.db, c.ctx, item.id, tractor(c.other.id)))).toContain("archivé");
    expect((await listEquipment(h.db, c.ctx, { q: "", sort: "client", dir: "asc", page: 1, archived: true })).total).toBe(1);

    const history = await equipmentHistory(h.db, c.ctx, item.id);
    expect(history.map((e) => e.action)).toEqual(["equipment.archived", "equipment.owner_changed", "equipment.created"]);
    expect(history[1]!.payload).toMatchObject({ from: { name: "GAEC des Prés" }, to: { name: "Paul Voisin" } });
  });

  it("isolation entre entreprises et droits par rôle", async () => {
    const a = await setup("IsoA");
    const b = await setup("IsoB");
    const item = await createEquipment(h.db, a.ctx, tractor(a.farmer.id));
    expect(await failure(getEquipment(h.db, b.ctx, item.id))).toContain("introuvable");
    expect(await failure(updateEquipment(h.db, b.ctx, item.id, tractor(b.farmer.id)))).toContain("introuvable");
    // Client ou facture d'une autre entreprise : refusés.
    expect(await failure(createEquipment(h.db, b.ctx, tractor(a.farmer.id, { serialNumber: "" })))).toContain("Client introuvable");
    expect(await failure(createEquipment(h.db, b.ctx, tractor(b.farmer.id, { serialNumber: "", salesDocumentId: a.invoice.id })))).toContain("facture émise");
    // Le même n° de série peut exister dans deux entreprises distinctes.
    await createEquipment(h.db, b.ctx, tractor(b.farmer.id));
    expect((await listEquipment(h.db, b.ctx, { q: "", sort: "client", dir: "asc", page: 1, archived: false })).total).toBe(1);

    const viewer: CompanyContext = { ...a.ctx, role: "viewer" };
    expect((await listEquipmentOfParty(h.db, viewer, a.farmer.id)).length).toBe(1);
    expect(await failure(createEquipment(h.db, viewer, tractor(a.farmer.id, { serialNumber: "" })))).toContain("droits");
    expect(await failure(setEquipmentArchived(h.db, viewer, item.id, true))).toContain("droits");
  });

  it("pièces jointes sur un matériel (carte grise, photos)", async () => {
    const c = await setup("ParcPJ");
    const item = await createEquipment(h.db, c.ctx, tractor(c.farmer.id));
    const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");
    await addAttachment(h.db, c.ctx, { entityType: "equipment", entityId: item.id, fileName: "carte-grise.pdf", data: PDF });
    const { rows, locked } = await listAttachments(h.db, c.ctx, "equipment", item.id);
    expect(rows.map((r) => r.fileName)).toEqual(["carte-grise.pdf"]);
    expect(locked).toBe(false);
    const other = await setup("ParcPJ2");
    expect(await failure(addAttachment(h.db, other.ctx, { entityType: "equipment", entityId: item.id, fileName: "x.pdf", data: PDF }))).toContain("introuvable");
  });

  it("la base refuse un compteur sans unité et une date mal formée", async () => {
    const c = await setup("ParcSQL");
    const item = await createEquipment(h.db, c.ctx, tractor(c.farmer.id));
    expect(await failure(h.db.execute(sql`update equipment set meter_unit = null where id = ${item.id}`))).toContain("equipment_meter_ck");
    expect(await failure(h.db.execute(sql`update equipment set sold_on = '21/10/2026' where id = ${item.id}`))).toContain("equipment_sold_on_ck");
  });
});
