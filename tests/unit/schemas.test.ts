import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { companySchema, contactSchema, productSchema, thirdPartySchema } from "@/lib/schemas";

/**
 * Les formulaires (React Hook Form + zodResolver) envoient au serveur la SORTIE du schéma,
 * que le serveur revalide avec le même schéma. Chaque schéma partagé doit donc être
 * idempotent : parse(parse(x)) === parse(x). Régression : l'adresse de livraison était
 * effacée car le drapeau hasShippingAddress disparaissait à la première transformation.
 */
function expectIdempotent<S extends z.ZodType>(schema: S, input: unknown) {
  const once = schema.parse(input);
  expect(schema.parse(once)).toEqual(once);
  return once;
}

describe("idempotence des schémas partagés", () => {
  it("tiers avec adresse de livraison", () => {
    const out = expectIdempotent(thirdPartySchema, {
      partyType: "business",
      name: "Boulangerie",
      siren: "732 829 320",
      hasShippingAddress: true,
      shippingLine1: "5 rue du Port",
      shippingPostalCode: "69007",
      shippingCity: "Lyon",
      paymentTermsDays: "45",
    });
    expect(out).toMatchObject({ siren: "732829320", shippingCity: "Lyon", shippingCountry: "FR", paymentTermsDays: 45 });
  });

  it("tiers sans adresse de livraison ni délai", () => {
    const out = expectIdempotent(thirdPartySchema, { partyType: "individual", name: "Jeanne", paymentTermsDays: "" });
    expect(out).toMatchObject({ shippingLine1: null, paymentTermsDays: null });
  });

  it("article avec prix à la française", () => {
    const out = expectIdempotent(productSchema, {
      reference: "A-1",
      name: "Article",
      kind: "good",
      unit: "unité",
      unitPriceExclTax: "1 234,50",
      purchasePriceExclTax: "",
      vatRateId: "3f1f6b0e-6d3c-4f43-9c43-1f0b4c1d2e3f",
    });
    expect(out).toMatchObject({ unitPriceExclTax: "1234.50", purchasePriceExclTax: null });
  });

  it("entreprise et contact", () => {
    expectIdempotent(companySchema, {
      legalName: "Atelier",
      nafCode: "62.01z",
      vatNumber: "fr 44 732829320",
      siren: "732829320",
      paymentTermsDays: "30",
      fiscalYearStartMonth: "7",
      invoicePrefix: "fa",
      creditNotePrefix: "AV",
      quotePrefix: "DE",
    });
    expectIdempotent(contactSchema, { fullName: "Paul", email: "", isPrimary: true });
  });
});
