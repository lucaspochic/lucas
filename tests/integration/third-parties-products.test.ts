import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/server/db/client";
import { addMember, listVatRates, resolveCompanyContext } from "@/server/services/companies";
import { registerUser } from "@/server/services/auth";
import {
  addContact,
  createThirdParty,
  exportThirdPartiesCsv,
  getThirdParty,
  importThirdPartiesCsv,
  listContacts,
  listThirdParties,
  setThirdPartyArchived,
  updateThirdParty,
} from "@/server/services/third-parties";
import {
  createProduct,
  exportProductsCsv,
  getProduct,
  importProductsCsv,
  listProducts,
  updateProduct,
} from "@/server/services/products";
import { listAuditEvents, verifyAuditChain } from "@/server/services/audit";
import { contacts, products } from "@/server/db/schema";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
let a: Awaited<ReturnType<typeof createUserWithCompany>>;
let b: Awaited<ReturnType<typeof createUserWithCompany>>;
const list = { q: "", sort: "nom" as const, dir: "asc" as const, page: 1, archived: false };

beforeAll(async () => {
  h = await createTestDb();
  a = await createUserWithCompany(h, "Tiers");
  b = await createUserWithCompany(h, "Autre");
});
afterAll(async () => {
  await h.close();
});

describe("tiers", () => {
  it("crée un client particulier avec un code automatique", async () => {
    const t = await createThirdParty(h.db, a.ctx, { partyType: "individual", name: "Jeanne Dupont", email: "jeanne@exemple.fr" });
    expect(t.code).toBe("C00001");
    expect(t.isCustomer).toBe(true);
    const t2 = await createThirdParty(h.db, a.ctx, { partyType: "business", name: "Bâti Pro SARL", siren: "732829320" });
    expect(t2.code).toBe("C00002");
  });

  it("attribue des codes fournisseurs distincts et saute un code déjà saisi", async () => {
    await createThirdParty(h.db, a.ctx, { code: "F00001", partyType: "business", name: "Grossiste manuel", isCustomer: false, isSupplier: true });
    const s = await createThirdParty(h.db, a.ctx, { partyType: "business", name: "Fournisseur auto", isCustomer: false, isSupplier: true });
    expect(s.code).toBe("F00002");
  });

  it("refuse un particulier avec SIREN, et un tiers ni client ni fournisseur", async () => {
    await expect(createThirdParty(h.db, a.ctx, { partyType: "individual", name: "X", siren: "732829320" })).rejects.toThrow();
    await expect(
      createThirdParty(h.db, a.ctx, { partyType: "business", name: "Y", isCustomer: false, isSupplier: false }),
    ).rejects.toThrow();
  });

  it("refuse un code en double", async () => {
    await expect(
      createThirdParty(h.db, a.ctx, { code: "C00001", partyType: "individual", name: "Doublon" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("recherche, filtre, trie, en échappant les jokers", async () => {
    const r = await listThirdParties(h.db, a.ctx, { ...list, q: "dupont" });
    expect(r.rows.map((x) => x.name)).toEqual(["Jeanne Dupont"]);
    const pros = await listThirdParties(h.db, a.ctx, { ...list, type: "business", role: "clients" });
    expect(pros.rows.map((x) => x.name)).toEqual(["Bâti Pro SARL"]);
    const suppliers = await listThirdParties(h.db, a.ctx, { ...list, role: "fournisseurs", sort: "code", dir: "desc" });
    expect(suppliers.rows.map((x) => x.code)).toEqual(["F00002", "F00001"]);
    expect((await listThirdParties(h.db, a.ctx, { ...list, q: "%" })).total).toBe(0);
  });

  it("met à jour avec différentiel audité, gère l'adresse de livraison", async () => {
    const [t] = (await listThirdParties(h.db, a.ctx, { ...list, q: "Bâti" })).rows;
    const updated = await updateThirdParty(h.db, a.ctx, t!.id, {
      partyType: "business",
      name: "Bâti Pro SARL",
      siren: "732829320",
      hasShippingAddress: true,
      shippingLine1: "Chantier, 3 rue Neuve",
      shippingPostalCode: "69003",
      shippingCity: "Lyon",
    });
    expect(updated.shippingCountry).toBe("FR");
    const [event] = await listAuditEvents(h.db, a.ctx, { limit: 1 });
    expect(event?.action).toBe("third_party.updated");
    expect(Object.keys((event?.payload as { changes: object }).changes)).toEqual(
      expect.arrayContaining(["shippingLine1", "shippingCity"]),
    );
  });

  it("archive puis restaure", async () => {
    const t = await createThirdParty(h.db, a.ctx, { partyType: "individual", name: "Client à archiver" });
    await setThirdPartyArchived(h.db, a.ctx, t.id, true);
    expect((await listThirdParties(h.db, a.ctx, { ...list, q: "archiver" })).total).toBe(0);
    expect((await listThirdParties(h.db, a.ctx, { ...list, q: "archiver", archived: true })).total).toBe(1);
    await expect(setThirdPartyArchived(h.db, a.ctx, t.id, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await setThirdPartyArchived(h.db, a.ctx, t.id, false);
  });

  it("gère les contacts avec un seul contact principal", async () => {
    const [t] = (await listThirdParties(h.db, a.ctx, { ...list, q: "Bâti" })).rows;
    await addContact(h.db, a.ctx, t!.id, { fullName: "Paul Chef", isPrimary: true });
    await addContact(h.db, a.ctx, t!.id, { fullName: "Anne Compta", isPrimary: true });
    const cs = await listContacts(h.db, a.ctx, t!.id);
    expect(cs.filter((c) => c.isPrimary).map((c) => c.fullName)).toEqual(["Anne Compta"]);
  });
});

describe("isolation des tiers et du catalogue", () => {
  it("une autre entreprise ne voit ni ne modifie les tiers", async () => {
    const [t] = (await listThirdParties(h.db, a.ctx, { ...list, q: "Dupont" })).rows;
    expect((await listThirdParties(h.db, b.ctx, list)).total).toBe(0);
    await expect(getThirdParty(h.db, b.ctx, t!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updateThirdParty(h.db, b.ctx, t!.id, { partyType: "individual", name: "Piraté" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(addContact(h.db, b.ctx, t!.id, { fullName: "Intrus" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("la base refuse un contact rattaché au tiers d'une autre entreprise", async () => {
    const [t] = (await listThirdParties(h.db, a.ctx, { ...list, q: "Dupont" })).rows;
    await expect(
      h.db.insert(contacts).values({ companyId: b.company.id, thirdPartyId: t!.id, fullName: "Contournement" }),
    ).rejects.toThrow();
  });

  it("un produit ne peut pas utiliser le taux de TVA d'une autre entreprise", async () => {
    const [foreignRate] = await listVatRates(h.db, b.ctx);
    await expect(
      createProduct(h.db, a.ctx, {
        reference: "X-1",
        name: "Test",
        kind: "good",
        unit: "unité",
        unitPriceExclTax: "10",
        vatRateId: foreignRate!.id,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    // Même en contournant le service, la clé composite refuse l'insertion.
    await expect(
      h.db.insert(products).values({
        companyId: a.company.id,
        reference: "X-2",
        name: "Test",
        kind: "good",
        unit: "unité",
        unitPriceExclTax: "10",
        vatRateId: foreignRate!.id,
      }),
    ).rejects.toThrow();
  });

  it("un membre en lecture seule ne peut pas écrire", async () => {
    const user = await registerUser(h.db, { fullName: "Lecteur Tiers", email: "lecteur.tiers@exemple.fr", password: "motdepasse-lecteur" });
    await addMember(h.db, a.ctx, { email: "lecteur.tiers@exemple.fr", role: "viewer" });
    const someParty = (await listThirdParties(h.db, a.ctx, list)).rows[0]!;
    const ctx = (await resolveCompanyContext(h.db, user.id, a.company.id))!;
    expect((await listThirdParties(h.db, ctx, list)).total).toBeGreaterThan(0);
    await expect(createThirdParty(h.db, ctx, { partyType: "individual", name: "Non" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setThirdPartyArchived(h.db, ctx, someParty.id, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(exportThirdPartiesCsv(h.db, ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("catalogue", () => {
  it("crée un article, calcule le TTC sans le stocker, normalise le prix", async () => {
    const rates = await listVatRates(h.db, a.ctx);
    const r20 = rates.find((r) => r.rate === "20.00")!;
    const p = await createProduct(h.db, a.ctx, {
      reference: "PREST-01",
      name: "Heure de conseil",
      kind: "service",
      unit: "heure",
      unitPriceExclTax: "83,33",
      vatRateId: r20.id,
    });
    expect(p.unitPriceExclTax).toBe("83.3300");
    const { rows } = await listProducts(h.db, a.ctx, { ...list, sort: "reference" });
    expect(rows[0]).toMatchObject({ reference: "PREST-01", priceInclTax: "100.00", vatRate: "20.00" });
  });

  it("refuse une référence en double (insensible à la casse) et un prix invalide", async () => {
    const [r] = await listVatRates(h.db, a.ctx);
    const base = { name: "Doublon", kind: "good" as const, unit: "unité" as const, unitPriceExclTax: "1", vatRateId: r!.id };
    await expect(createProduct(h.db, a.ctx, { ...base, reference: "prest-01" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createProduct(h.db, a.ctx, { ...base, reference: "OK-1", unitPriceExclTax: "-5" })).rejects.toThrow();
    await expect(createProduct(h.db, a.ctx, { ...base, reference: "OK-2", unitPriceExclTax: "1.23456" })).rejects.toThrow();
  });

  it("trace la modification de prix", async () => {
    const { rows } = await listProducts(h.db, a.ctx, { ...list, q: "PREST-01" });
    const p = rows[0]!;
    await updateProduct(h.db, a.ctx, p.id, {
      reference: p.reference,
      name: p.name,
      kind: p.kind,
      unit: "heure",
      unitPriceExclTax: "90",
      vatRateId: p.vatRateId,
    });
    expect((await getProduct(h.db, a.ctx, p.id)).unitPriceExclTax).toBe("90.0000");
    const [event] = await listAuditEvents(h.db, a.ctx, { limit: 1 });
    expect((event?.payload as { changes: Record<string, unknown> }).changes.unitPriceExclTax).toEqual({
      from: "83.3300",
      to: "90.0000",
    });
  });
});

describe("import / export CSV", () => {
  it("rejette tout le fichier si une ligne est invalide, avec le numéro de ligne", async () => {
    const before = (await listThirdParties(h.db, a.ctx, list)).total;
    const csv = "type;nom;siren\nparticulier;Valide Un;\nprofessionnel;SIREN faux;123456789\n";
    const report = await importThirdPartiesCsv(h.db, a.ctx, csv);
    expect(report.imported).toBe(0);
    expect(report.errors).toEqual([{ line: 3, message: expect.stringMatching(/SIREN invalide/) }]);
    expect((await listThirdParties(h.db, a.ctx, list)).total).toBe(before);
  });

  it("rejette un code déjà existant en base sans rien importer", async () => {
    const report = await importThirdPartiesCsv(h.db, a.ctx, "code;type;nom\nZ1;particulier;Nouveau\nC00001;particulier;Collision\n");
    expect(report.imported).toBe(0);
    expect(report.errors[0]?.message).toMatch(/Ligne 3.*C00001/);
    expect((await listThirdParties(h.db, a.ctx, { ...list, q: "Nouveau" })).total).toBe(0);
  });

  it("importe un fichier valide et l'export est réimportable", async () => {
    const report = await importThirdPartiesCsv(
      h.db,
      a.ctx,
      "Type;Nom;Client;Fournisseur;Code postal;Ville\nParticulier;Import Un;oui;non;75001;Paris\nProfessionnel;Import Deux;non;oui;;\n",
    );
    expect(report).toEqual({ imported: 2, errors: [] });
    const csv = await exportThirdPartiesCsv(h.db, a.ctx);
    expect(csv).toContain("Import Un");
    // Réimport dans l'autre entreprise : mêmes données, codes conservés.
    const again = await importThirdPartiesCsv(h.db, b.ctx, csv);
    expect(again.errors).toEqual([]);
    expect(again.imported).toBe((await listThirdParties(h.db, a.ctx, list)).total);
  });

  it("importe des articles avec prix et taux à la française", async () => {
    const report = await importProductsCsv(
      h.db,
      a.ctx,
      "Référence;Désignation;Nature;Unité;Prix vente HT;Taux TVA;Code-barres\nBAG-1;Baguette;bien;unité;1,10;5,5;3017620422003\nLIV-1;Livraison;service;forfait;15;20;\n",
    );
    expect(report).toEqual({ imported: 2, errors: [] });
    const csv = await exportProductsCsv(h.db, a.ctx);
    expect(csv).toContain("BAG-1;Baguette;;;bien;unité;1,1000;;5,50;3017620422003");
    const bad = await importProductsCsv(h.db, a.ctx, "reference;designation;nature;unite;prix_vente_ht;taux_tva\nZ;Z;bien;unité;1;7\n");
    expect(bad.errors[0]?.message).toMatch(/taux_tva/);
  });

  it("la chaîne d'audit reste intègre après tous ces traitements", async () => {
    expect((await verifyAuditChain(h.db, a.company.id)).valid).toBe(true);
    expect((await verifyAuditChain(h.db, b.company.id)).valid).toBe(true);
  });
});
