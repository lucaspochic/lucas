import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/server/db/client";
import { listVatRates, updateCompany } from "@/server/services/companies";
import { createThirdParty } from "@/server/services/third-parties";
import { createCreditNoteDraft, createDraft, issueDocument, updateDraft } from "@/server/services/sales";
import { recordPayment } from "@/server/services/payments";
import { getDashboard, lastTwelveMonths, periodBounds } from "@/server/services/dashboard";
import { createTestDb, createUserWithCompany } from "../helpers/db";

describe("périodes", () => {
  it("bornes des périodes", () => {
    expect(periodBounds("mois", "2026-10-21", 1)).toEqual({ from: "2026-10-01", to: "2026-10-21" });
    expect(periodBounds("trimestre", "2026-11-05", 1)).toEqual({ from: "2026-10-01", to: "2026-11-05" });
    expect(periodBounds("exercice", "2026-10-21", 7)).toEqual({ from: "2026-07-01", to: "2026-10-21" });
    expect(periodBounds("exercice", "2026-03-10", 7)).toEqual({ from: "2025-07-01", to: "2026-03-10" });
    expect(periodBounds("12mois", "2026-10-21", 1)).toEqual({ from: "2025-11-01", to: "2026-10-21" });
  });

  it("12 derniers mois", () => {
    const m = lastTwelveMonths("2026-02-15");
    expect(m[0]).toBe("2025-03");
    expect(m[11]).toBe("2026-02");
    expect(m).toHaveLength(12);
  });
});

describe("indicateurs calculés sur les données réelles", () => {
  let h: DbHandle;
  let a: Awaited<ReturnType<typeof createUserWithCompany>>;
  const SEPT = new Date("2026-09-10T10:00:00Z");
  const OCT = new Date("2026-10-21T10:00:00Z");

  beforeAll(async () => {
    h = await createTestDb();
    a = await createUserWithCompany(h, "Tableau");
    await updateCompany(h.db, a.ctx, {
      legalName: "Tableau SAS",
      siren: "732829320",
      vatNumber: "FR44732829320",
      addressLine1: "1 rue",
      postalCode: "69001",
      city: "Lyon",
      paymentTermsDays: 30,
      latePenaltyText: "Pénalités.",
      invoicePrefix: "FA",
      creditNotePrefix: "AV",
      quotePrefix: "DE",
    });
    const rate = (await listVatRates(h.db, a.ctx)).find((r) => r.rate === "20.00")!.id;
    const customer = await createThirdParty(h.db, a.ctx, { partyType: "individual", name: "Client", billingLine1: "2 rue", billingCity: "Lyon" });
    const invoice = async (ht: string, now: Date) => {
      const d = await createDraft(h.db, a.ctx, "invoice", {
        thirdPartyId: customer.id,
        lines: [{ description: "X", kind: "service", quantity: "1", unit: "forfait", unitPriceExclTax: ht, vatRateId: rate }],
      });
      return issueDocument(h.db, a.ctx, d.id, { now });
    };
    // Septembre : facture 1000 HT (1200 TTC), échue le 10/10, payée 200.
    const septInv = await invoice("1000", SEPT);
    await recordPayment(
      h.db,
      a.ctx,
      { idempotencyKey: randomUUID(), kind: "receipt", thirdPartyId: customer.id, paymentDate: "2026-09-15", method: "transfer", amount: "200", allocations: [{ documentId: septInv.id, amount: "200" }] },
      { now: new Date("2026-09-20T10:00:00Z") },
    );
    // Octobre : facture 500 HT (600 TTC) payée intégralement, et avoir de 100 HT sur la facture de septembre.
    const octInv = await invoice("500", OCT);
    await recordPayment(
      h.db,
      a.ctx,
      { idempotencyKey: randomUUID(), kind: "receipt", thirdPartyId: customer.id, paymentDate: "2026-10-20", method: "card", amount: "600", allocations: [{ documentId: octInv.id, amount: "600" }] },
      { now: OCT },
    );
    const credit = await createCreditNoteDraft(h.db, a.ctx, septInv.id);
    await updateDraft(h.db, a.ctx, credit.id, {
      thirdPartyId: customer.id,
      lines: [{ description: "Remise", kind: "service", quantity: "1", unit: "forfait", unitPriceExclTax: "100", vatRateId: rate }],
    });
    await issueDocument(h.db, a.ctx, credit.id, { now: OCT });
    // Brouillon ignoré par tous les indicateurs.
    await createDraft(h.db, a.ctx, "invoice", {
      thirdPartyId: customer.id,
      lines: [{ description: "Brouillon", kind: "service", quantity: "1", unit: "forfait", unitPriceExclTax: "99999", vatRateId: rate }],
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it("mois en cours : CA net des avoirs, encaissements, TVA estimée", async () => {
    const d = await getDashboard(h.db, a.ctx, "mois", OCT);
    expect(d.revenueExclTax).toBe("400.00"); // 500 − 100
    expect(d.estimatedVat).toBe("80.00"); // 100 − 20
    expect(d.collected).toBe("600.00");
    expect(d.invoiceCount).toBe(1);
  });

  it("12 derniers mois : cumul et ventilation mensuelle", async () => {
    const d = await getDashboard(h.db, a.ctx, "12mois", OCT);
    expect(d.revenueExclTax).toBe("1400.00");
    expect(d.collected).toBe("800.00");
    const sept = d.chart.months.indexOf("2026-09");
    const oct = d.chart.months.indexOf("2026-10");
    expect(d.chart.revenue[sept]).toBe("1000.00");
    expect(d.chart.revenue[oct]).toBe("400.00");
    expect(d.chart.collected[sept]).toBe("200.00");
    expect(d.chart.collected[oct]).toBe("600.00");
  });

  it("créances et retards à date (avoirs et règlements déduits)", async () => {
    const d = await getDashboard(h.db, a.ctx, "mois", OCT);
    // Facture de septembre : 1200 − 120 (avoir) − 200 (réglé) = 880, échue le 10/10.
    expect(d.receivables).toEqual({ amount: "880.00", count: 1 });
    expect(d.overdue.amount).toBe("880.00");
    expect(d.overdue.count).toBe(1);
  });

  it("une entreprise sans activité n'affiche que des zéros", async () => {
    const other = await createUserWithCompany(h, "Vide");
    const d = await getDashboard(h.db, other.ctx, "12mois", OCT);
    expect(d).toMatchObject({ revenueExclTax: "0.00", collected: "0.00", estimatedVat: "0.00", receivables: { amount: "0.00", count: 0 } });
    expect(d.chart.revenue.every((v) => v === "0")).toBe(true);
  });
});
