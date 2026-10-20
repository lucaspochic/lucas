import { describe, expect, it } from "vitest";
import { csvToRecords, escapeCsvCell, parseCsv, parseFrenchDecimal, toCsv } from "@/server/domain/csv";
import { isValidGtin } from "@/server/domain/identifiers";

describe("lecture CSV", () => {
  it("gère guillemets, séparateurs et retours à la ligne dans les champs", () => {
    const rows = parseCsv('nom;notes\r\n"Dupont; fils";"ligne 1\nligne ""2"""\r\nMartin;\r\n');
    expect(rows).toEqual([
      ["nom", "notes"],
      ["Dupont; fils", 'ligne 1\nligne "2"'],
      ["Martin", ""],
    ]);
  });

  it("détecte le séparateur virgule et ignore le BOM et les lignes vides", () => {
    expect(parseCsv("﻿a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("refuse un guillemet non fermé", () => {
    expect(() => parseCsv('a;b\n"x;y\n')).toThrow(/guillemet/);
  });

  it("normalise les en-têtes", () => {
    const { headers, records } = csvToRecords("Code Postal;Téléphone;Prix vente HT\n69002;0102030405;12,50\n");
    expect(headers).toEqual(["code_postal", "telephone", "prix_vente_ht"]);
    expect(records[0]).toEqual({ code_postal: "69002", telephone: "0102030405", prix_vente_ht: "12,50" });
  });
});

describe("écriture CSV", () => {
  it("neutralise les formules (injection CSV)", () => {
    expect(escapeCsvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(escapeCsvCell("+33 1 02")).toBe("'+33 1 02");
    expect(escapeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("produit un fichier relisible (aller-retour)", () => {
    const csv = toCsv(["a", "b"], [["x;y", 'dit "bonjour"'], [null, 3]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ["x;y", 'dit "bonjour"'],
      ["", "3"],
    ]);
  });
});

describe("décimaux et codes-barres", () => {
  it.each([
    ["1 234,50", "1234.50"],
    ["1.234,5", "1234.5"],
    ["12.5", "12.5"],
    ["12,50 €", "12.50"],
    ["abc", null],
    ["", null],
  ])("%s → %s", (input, expected) => {
    expect(parseFrenchDecimal(input)).toBe(expected);
  });

  it("vérifie la clé des codes GTIN", () => {
    expect(isValidGtin("3017620422003")).toBe(true); // EAN-13
    expect(isValidGtin("3017620422004")).toBe(false);
    expect(isValidGtin("96385074")).toBe(true); // EAN-8
    expect(isValidGtin("12345")).toBe(false);
  });
});
