import { describe, expect, it } from "vitest";
import {
  frenchVatNumberFromSiren,
  isValidFrenchVatNumber,
  isValidIban,
  isValidNafCode,
  isValidSiren,
  isValidSiret,
} from "@/server/domain/identifiers";
import { fiscalYearOf, formatDocumentNumber, todayInParis } from "@/server/domain/numbering";
import { canonicalJson } from "@/server/security/canonical-json";

describe("identifiants d'entreprise", () => {
  it("valide le SIREN par la clé de Luhn", () => {
    expect(isValidSiren("732 829 320")).toBe(true);
    expect(isValidSiren("732829321")).toBe(false);
    expect(isValidSiren("12345678")).toBe(false);
  });

  it("valide le SIRET, y compris l'exception La Poste", () => {
    expect(isValidSiret("73282932000074")).toBe(true);
    expect(isValidSiret("73282932000075")).toBe(false);
    expect(isValidSiret("35600000000010")).toBe(true); // somme des chiffres multiple de 5
    expect(isValidSiret("35600000000011")).toBe(false);
  });

  it("calcule et vérifie la clé de TVA intracommunautaire", () => {
    expect(frenchVatNumberFromSiren("732829320")).toBe("FR44732829320");
    expect(isValidFrenchVatNumber("FR 44 732829320")).toBe(true);
    expect(isValidFrenchVatNumber("FR45732829320")).toBe(false);
  });

  it("valide le code NAF et l'IBAN", () => {
    expect(isValidNafCode("6201Z")).toBe(true);
    expect(isValidNafCode("62.01Z")).toBe(true);
    expect(isValidNafCode("620Z")).toBe(false);
    expect(isValidIban("FR76 3000 6000 0112 3456 7890 189")).toBe(true);
    expect(isValidIban("FR76 3000 6000 0112 3456 7890 188")).toBe(false);
  });
});

describe("numérotation", () => {
  it("formate les numéros", () => {
    expect(formatDocumentNumber("FA", 2026, 42)).toBe("FA-2026-00042");
    expect(() => formatDocumentNumber("fa-", 2026, 1)).toThrow();
    expect(() => formatDocumentNumber("FA", 2026, 0)).toThrow();
  });

  it("rattache une date à son exercice", () => {
    expect(fiscalYearOf("2026-12-31", 1)).toBe(2026);
    expect(fiscalYearOf("2026-06-30", 7)).toBe(2026);
    expect(fiscalYearOf("2026-07-01", 7)).toBe(2027);
  });

  it("donne la date du jour à Paris", () => {
    // 31/12/2026 23:30 UTC = 01/01/2027 00:30 à Paris
    expect(todayInParis(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });
});

describe("JSON canonique", () => {
  it("trie les clés récursivement", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: true, y: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":null,"z":true}]},"b":1}',
    );
  });

  it("refuse les nombres non entiers", () => {
    expect(() => canonicalJson({ amount: 12.5 })).toThrow(TypeError);
  });
});
