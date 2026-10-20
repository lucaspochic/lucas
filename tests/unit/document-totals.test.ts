import { describe, expect, it } from "vitest";
import { CalculationError, computeDocumentTotals, computeLineExclTax, priceInclTax } from "@/server/domain/document-totals";
import { dec, formatEuro, roundMoney, toMoneyString } from "@/server/domain/money";

describe("arrondi monétaire", () => {
  it.each([
    ["0.005", "0.01"],
    ["0.004", "0.00"],
    ["1.115", "1.12"],
    ["2.675", "2.68"], // piège classique des flottants binaires (2.675 → 2.67 en double)
    ["-0.005", "-0.01"],
    ["1234.5", "1234.50"],
  ])("%s → %s", (input, expected) => {
    expect(toMoneyString(roundMoney(dec(input)))).toBe(expected);
  });

  it("refuse les nombres flottants JavaScript", () => {
    expect(() => dec(0.1)).toThrow(TypeError);
    expect(() => dec("1,5")).toThrow(TypeError);
    expect(() => dec("1e3")).toThrow(TypeError);
  });

  it("0.1 + 0.2 vaut exactement 0.3", () => {
    expect(dec("0.1").plus(dec("0.2")).toString()).toBe("0.3");
  });

  it("formate en euros à la française", () => {
    expect(formatEuro("1234567.891")).toBe("1 234 567,89 €");
    expect(formatEuro("-12.5")).toBe("-12,50 €");
  });
});

describe("total HT de ligne", () => {
  it("quantité × prix unitaire", () => {
    expect(toMoneyString(computeLineExclTax({ quantity: "3", unitPriceExclTax: "19.99", vatRate: "20" }))).toBe("59.97");
  });

  it("applique la remise de ligne puis arrondit au centime", () => {
    // 1.5 × 33.3333 = 49.99995 ; − 10 % = 44.999955 → 45.00
    expect(
      toMoneyString(computeLineExclTax({ quantity: "1.5", unitPriceExclTax: "33.3333", vatRate: "20", discountPercent: "10" })),
    ).toBe("45.00");
  });

  it("refuse une précision excessive", () => {
    expect(() => computeLineExclTax({ quantity: "1", unitPriceExclTax: "1.00001", vatRate: "20" })).toThrow(CalculationError);
    expect(() => computeLineExclTax({ quantity: "1.0001", unitPriceExclTax: "1", vatRate: "20" })).toThrow(CalculationError);
  });

  it("refuse une remise hors bornes", () => {
    expect(() => computeLineExclTax({ quantity: "1", unitPriceExclTax: "1", vatRate: "20", discountPercent: "101" })).toThrow(
      CalculationError,
    );
  });
});

describe("totaux de document", () => {
  it("regroupe la TVA par taux et arrondit par taux", () => {
    const totals = computeDocumentTotals({
      lines: [
        { quantity: "1", unitPriceExclTax: "0.33", vatRate: "20" },
        { quantity: "1", unitPriceExclTax: "0.33", vatRate: "20" },
        { quantity: "1", unitPriceExclTax: "0.33", vatRate: "20" },
        { quantity: "2", unitPriceExclTax: "10.00", vatRate: "5.5" },
      ],
    });
    expect(totals.vatBreakdown).toEqual([
      { vatRate: "20", vatExemptionReason: null, baseExclTax: "0.99", vatAmount: "0.20" }, // 0.198 → 0.20
      { vatRate: "5.5", vatExemptionReason: null, baseExclTax: "20.00", vatAmount: "1.10" },
    ]);
    expect(totals.totalExclTax).toBe("20.99");
    expect(totals.totalVat).toBe("1.30");
    expect(totals.totalInclTax).toBe("22.29");
    expect(totals.amountDue).toBe("22.29");
  });

  it("HT + TVA = TTC sur un échantillon aléatoire déterministe", () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const rates = ["20", "10", "5.5", "2.1"];
    for (let i = 0; i < 300; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => ({
        quantity: (1 + Math.floor(rand() * 50)).toString(),
        unitPriceExclTax: (Math.floor(rand() * 1_000_000) / 100).toFixed(2),
        vatRate: rates[Math.floor(rand() * rates.length)]!,
        discountPercent: Math.floor(rand() * 30).toString(),
      }));
      const t = computeDocumentTotals({ lines, globalDiscountPercent: Math.floor(rand() * 10).toString() });
      expect(dec(t.totalExclTax).plus(t.totalVat).toFixed(2)).toBe(t.totalInclTax);
      const sumLines = t.lines.reduce((acc, l) => acc.plus(l.totalExclTax), dec("0"));
      expect(sumLines.toFixed(2)).toBe(t.totalExclTax);
    }
  });

  it("ventile la remise globale par taux", () => {
    const t = computeDocumentTotals({
      lines: [
        { quantity: "1", unitPriceExclTax: "100", vatRate: "20" },
        { quantity: "1", unitPriceExclTax: "50", vatRate: "10" },
      ],
      globalDiscountPercent: "10",
    });
    expect(t.vatBreakdown.map((v) => [v.baseExclTax, v.vatAmount])).toEqual([
      ["90.00", "18.00"],
      ["45.00", "4.50"],
    ]);
    expect(t.totalInclTax).toBe("157.50");
  });

  it("déduit les acomptes du net à payer sans modifier la TVA", () => {
    const t = computeDocumentTotals({
      lines: [{ quantity: "1", unitPriceExclTax: "1000", vatRate: "20" }],
      depositsInclTax: "360.00",
    });
    expect(t.totalVat).toBe("200.00");
    expect(t.totalInclTax).toBe("1200.00");
    expect(t.amountDue).toBe("840.00");
  });

  it("refuse des acomptes supérieurs au total", () => {
    expect(() =>
      computeDocumentTotals({ lines: [{ quantity: "1", unitPriceExclTax: "10", vatRate: "20" }], depositsInclTax: "12.01" }),
    ).toThrow(CalculationError);
  });

  it("exige un motif d'exonération pour le taux 0 et le conserve", () => {
    expect(() => computeDocumentTotals({ lines: [{ quantity: "1", unitPriceExclTax: "10", vatRate: "0" }] })).toThrow(
      /motif d'exonération/,
    );
    const t = computeDocumentTotals({
      lines: [{ quantity: "1", unitPriceExclTax: "10", vatRate: "0", vatExemptionReason: "TVA non applicable, art. 293 B du CGI" }],
    });
    expect(t.vatBreakdown[0]).toMatchObject({ vatAmount: "0.00", vatExemptionReason: "TVA non applicable, art. 293 B du CGI" });
  });

  it("gère les quantités négatives (lignes d'avoir)", () => {
    const t = computeDocumentTotals({ lines: [{ quantity: "-2", unitPriceExclTax: "12.345", vatRate: "20" }] });
    expect(t.totalExclTax).toBe("-24.69");
    expect(t.totalVat).toBe("-4.94"); // -4.938 → -4.94 (symétrique)
    expect(t.totalInclTax).toBe("-29.63");
  });

  it("refuse un document sans ligne", () => {
    expect(() => computeDocumentTotals({ lines: [] })).toThrow(CalculationError);
  });

  it("est déterministe", () => {
    const input = { lines: [{ quantity: "7", unitPriceExclTax: "3.1415", vatRate: "10", discountPercent: "3.5" }] };
    expect(computeDocumentTotals(input)).toEqual(computeDocumentTotals(input));
  });
});

describe("prix TTC de catalogue", () => {
  it.each([
    ["10.00", "20", "12.00"],
    ["8.33", "20", "10.00"], // 9.996 → 10.00
    ["4.7393", "5.5", "5.00"],
  ])("%s HT à %s %% → %s TTC", (ht, rate, ttc) => {
    expect(priceInclTax(ht, rate)).toBe(ttc);
  });
});
