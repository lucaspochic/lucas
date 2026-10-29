import { describe, expect, it } from "vitest";
import { isPartySection, partyHref, partySection } from "@/lib/party-sections";

describe("rubriques clients / fournisseurs", () => {
  const client = { id: "c", isCustomer: true, isSupplier: false };
  const supplier = { id: "f", isCustomer: false, isSupplier: true };
  const both = { id: "b", isCustomer: true, isSupplier: true };

  it("ouvre une fiche dans la rubrique de son rôle", () => {
    expect(partyHref(client)).toBe("/clients/c");
    expect(partyHref(supplier)).toBe("/fournisseurs/f");
    expect(partyHref(both)).toBe("/clients/b");
  });

  it("respecte la rubrique demandée seulement si le tiers y figure", () => {
    expect(partySection(both, "fournisseurs")).toBe("fournisseurs");
    expect(partySection(supplier, "clients")).toBe("fournisseurs");
    expect(partySection(client, "fournisseurs")).toBe("clients");
  });

  it("n'accepte que les deux rubriques connues", () => {
    expect(isPartySection("clients")).toBe(true);
    expect(isPartySection("fournisseurs")).toBe(true);
    expect(isPartySection("tiers")).toBe(false);
    expect(isPartySection(undefined)).toBe(false);
  });
});
