import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { bankTransactions, expenseLines, expensePayments, expenses } from "@/server/db/schema";
import { listVatRates, updateCompany } from "@/server/services/companies";
import { createThirdParty } from "@/server/services/third-parties";
import { createDraft, issueDocument } from "@/server/services/sales";
import { recordPayment } from "@/server/services/payments";
import {
  createExpense,
  deleteExpenseDraft,
  getExpense,
  listExpenses,
  payExpense,
  reverseExpensePayment,
  updateExpense,
  validateExpense,
} from "@/server/services/expenses";
import {
  accountBalances,
  cashForecast,
  createBankAccount,
  importBankStatement,
  listBankAccounts,
  listUnreconciled,
  parseStatementDate,
  reconcile,
  unreconcile,
} from "@/server/services/treasury";
import { verifyAuditChain } from "@/server/services/audit";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
let a: Awaited<ReturnType<typeof createUserWithCompany>>;
let b: Awaited<ReturnType<typeof createUserWithCompany>>;
let supplierId: string;
let customerId: string;
const NOW = new Date("2026-10-21T10:00:00Z");

async function dbError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} | ${e.cause?.message ?? ""}`;
  }
  throw new Error("La requête aurait dû être refusée.");
}

const expenseInput = (overrides: Record<string, unknown> = {}) => ({
  thirdPartyId: supplierId,
  supplierReference: "F-2026-118",
  invoiceDate: "2026-10-15",
  lines: [
    { category: "loyer", description: "Loyer octobre", amountExclTax: "1000", vatRate: "20" },
    { category: "fournitures_bureau", description: "Papier", amountExclTax: "33.33", vatRate: "20", vatAmount: "6.67" },
  ],
  ...overrides,
});

beforeAll(async () => {
  h = await createTestDb();
  a = await createUserWithCompany(h, "Treso");
  b = await createUserWithCompany(h, "Autre");
  supplierId = (await createThirdParty(h.db, a.ctx, { partyType: "business", name: "Bailleur SCI", isCustomer: false, isSupplier: true })).id;
  customerId = (await createThirdParty(h.db, a.ctx, { partyType: "individual", name: "Client", billingLine1: "1 rue", billingCity: "Lyon" })).id;
});
afterAll(async () => {
  await h.close();
});

describe("comptes de trésorerie", () => {
  it("une entreprise reçoit un compte courant et une caisse par défaut", async () => {
    const accounts = await listBankAccounts(h.db, a.ctx);
    expect(accounts.map((x) => [x.kind, x.ledgerAccount, x.isDefault])).toEqual([
      ["bank", "512000", true],
      ["cash", "530000", true],
    ]);
  });

  it("crée un second compte bancaire, refuse un compte comptable incohérent ou en double", async () => {
    const acc = await createBankAccount(h.db, a.ctx, { kind: "bank", name: "Livret pro", ledgerAccount: "512100", openingBalance: "1 500,00", openingDate: "2026-01-01" });
    expect(acc.openingBalance).toBe("1500.00");
    await expect(createBankAccount(h.db, a.ctx, { kind: "bank", name: "Compte X", ledgerAccount: "530100", openingBalance: "0", openingDate: "2026-01-01" })).rejects.toThrow();
    await expect(createBankAccount(h.db, a.ctx, { kind: "bank", name: "Compte Y", ledgerAccount: "512100", openingBalance: "0", openingDate: "2026-01-01" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("dépenses", () => {
  it("calcule HT, TVA (tolérance d'arrondi fournisseur) et TTC", async () => {
    const e = await createExpense(h.db, a.ctx, expenseInput());
    const { expense, lines } = await getExpense(h.db, a.ctx, e.id);
    expect(lines.map((l) => [l.ledgerAccount, l.amountExclTax, l.vatAmount])).toEqual([
      ["613200", "1000.00", "200.00"],
      ["606400", "33.33", "6.67"], // calculée 6,67 — saisie acceptée
    ]);
    expect(expense).toMatchObject({ status: "draft", number: null, totalExclTax: "1033.33", totalVat: "206.67", totalInclTax: "1240.00" });
  });

  it("refuse une TVA saisie trop éloignée du calcul et un tiers non fournisseur", async () => {
    await expect(
      createExpense(h.db, a.ctx, expenseInput({ lines: [{ category: "autre", description: "X", amountExclTax: "100", vatRate: "20", vatAmount: "25" }] })),
    ).rejects.toThrow(/trop éloignée/);
    await expect(createExpense(h.db, a.ctx, expenseInput({ thirdPartyId: customerId }))).rejects.toThrow(/Fournisseur inconnu/);
  });

  it("valide (numéro ACH, échéance par défaut), puis fige la dépense", async () => {
    const e = await createExpense(h.db, a.ctx, expenseInput());
    const v = await validateExpense(h.db, a.ctx, e.id, { now: NOW });
    expect(v).toMatchObject({ status: "validated", number: "ACH-2026-00001", dueDate: "2026-11-14" });
    await expect(updateExpense(h.db, a.ctx, e.id, expenseInput())).rejects.toMatchObject({ code: "IMMUTABLE" });
    await expect(deleteExpenseDraft(h.db, a.ctx, e.id)).rejects.toMatchObject({ code: "IMMUTABLE" });
    expect(await dbError(h.db.update(expenses).set({ totalInclTax: "1.00" }).where(eq(expenses.id, e.id)))).toMatch(/modification interdite/);
    expect(await dbError(h.db.delete(expenseLines).where(eq(expenseLines.expenseId, e.id)))).toMatch(/lignes non modifiables/);
  });

  it("paiement partiel, rejeu sans doublon, dépassement refusé, contre-passation", async () => {
    const e = await validateExpense(h.db, a.ctx, (await createExpense(h.db, a.ctx, expenseInput())).id, { now: NOW });
    const key = randomUUID();
    const input = { idempotencyKey: key, paymentDate: "2026-10-20", method: "transfer", amount: "1000" };
    const p1 = await payExpense(h.db, a.ctx, e.id, input, { now: NOW });
    const p2 = await payExpense(h.db, a.ctx, e.id, input, { now: NOW });
    expect(p2).toMatchObject({ replayed: true, result: { id: p1.result.id } });
    expect(p1.result.number).toMatch(/^PF-2026-\d{5}$/);
    expect((await getExpense(h.db, a.ctx, e.id)).expense.amountPaid).toBe("1000.00");
    await expect(
      payExpense(h.db, a.ctx, e.id, { idempotencyKey: randomUUID(), paymentDate: "2026-10-20", method: "transfer", amount: "240.01" }, { now: NOW }),
    ).rejects.toThrow(/reste à payer/);
    const rev = await reverseExpensePayment(h.db, a.ctx, p1.result.id, { idempotencyKey: randomUUID(), reason: "Virement rejeté" }, { now: NOW });
    expect(rev.result.amount).toBe("-1000.00");
    expect((await getExpense(h.db, a.ctx, e.id)).expense.amountPaid).toBe("0.00");
    expect(await dbError(h.db.delete(expensePayments).where(eq(expensePayments.id, p1.result.id)))).toMatch(/ajout seul/);
  });

  it("liste par statut et isolation entre entreprises", async () => {
    const toPay = await listExpenses(h.db, a.ctx, { q: "", sort: "date", dir: "desc", page: 1, status: "to_pay" });
    expect(toPay.total).toBeGreaterThanOrEqual(2);
    expect((await listExpenses(h.db, b.ctx, { q: "", sort: "date", dir: "desc", page: 1 })).total).toBe(0);
    await expect(getExpense(h.db, b.ctx, toPay.rows[0]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("relevés et rapprochement", () => {
  let bankId: string;
  const statement = "Date;Libellé;Débit;Crédit\n20/10/2026;VIR SEPA CLIENT DUPONT;;120,00\n20/10/2026;PRLV SCI BAILLEUR;1 240,00;\n21/10/2026;FRAIS TENUE COMPTE;8,50;\n21/10/2026;FRAIS TENUE COMPTE;8,50;\n";

  beforeAll(async () => {
    bankId = (await listBankAccounts(h.db, a.ctx)).find((x) => x.ledgerAccount === "512000")!.id;
  });

  it("dates de relevé", () => {
    expect(parseStatementDate("21/10/2026")).toBe("2026-10-21");
    expect(parseStatementDate("1/2/26")).toBe("2026-02-01");
    expect(parseStatementDate("31/02/2026")).toBeNull();
  });

  it("importe, distingue deux lignes identiques, et ne crée aucun doublon au réimport", async () => {
    const first = await importBankStatement(h.db, a.ctx, bankId, statement);
    expect(first).toEqual({ imported: 4, duplicates: 0, errors: [] });
    const again = await importBankStatement(h.db, a.ctx, bankId, statement);
    expect(again).toEqual({ imported: 0, duplicates: 4, errors: [] });
    const bad = await importBankStatement(h.db, a.ctx, bankId, "date;libelle;montant\n32/13/2026;X;10\n");
    expect(bad.errors[0]).toMatchObject({ line: 2 });
  });

  it("rapproche un règlement client (suggestion) et un paiement fournisseur", async () => {
    const inv = await issueDocument(
      h.db,
      a.ctx,
      (
        await createDraft(h.db, a.ctx, "invoice", {
          thirdPartyId: customerId,
          lines: [{ description: "X", kind: "service", quantity: "1", unit: "forfait", unitPriceExclTax: "100", vatRateId: (await listVatRates(h.db, a.ctx))[0]!.id }],
        })
      ).id,
      { now: NOW },
    ).catch(() => null);
    // L'entreprise de test n'a pas de mentions complètes : règlement non imputé (acompte), même montant.
    void inv;
    const pay = await recordPayment(
      h.db,
      a.ctx,
      { idempotencyKey: randomUUID(), kind: "receipt", thirdPartyId: customerId, paymentDate: "2026-10-19", method: "transfer", amount: "120", allocations: [] },
      { now: NOW },
    );
    expect(pay.result.bankAccountId).toBe(bankId);
    const e = await validateExpense(h.db, a.ctx, (await createExpense(h.db, a.ctx, expenseInput())).id, { now: NOW });
    const supplierPay = await payExpense(
      h.db,
      a.ctx,
      e.id,
      { idempotencyKey: randomUUID(), paymentDate: "2026-10-20", method: "direct_debit", amount: "1240" },
      { now: NOW },
    );

    const lines = await listUnreconciled(h.db, a.ctx, bankId);
    const credit = lines.find((l) => l.amount === "120.00")!;
    const debit = lines.find((l) => l.amount === "-1240.00")!;
    expect(credit.candidates.map((c) => c.id)).toContain(pay.result.id);
    expect(debit.candidates.map((c) => c.id)).toContain(supplierPay.result.id);

    await reconcile(h.db, a.ctx, credit.id, { type: "payment", id: pay.result.id });
    await reconcile(h.db, a.ctx, debit.id, { type: "expense_payment", id: supplierPay.result.id });
    await expect(reconcile(h.db, a.ctx, credit.id, { type: "payment", id: pay.result.id })).rejects.toMatchObject({ code: "CONFLICT" });
    const fee = lines.find((l) => l.amount === "-8.50")!;
    await expect(reconcile(h.db, a.ctx, fee.id, { type: "payment", id: pay.result.id })).rejects.toThrow();
    expect((await listUnreconciled(h.db, a.ctx, bankId)).length).toBe(2);
    await unreconcile(h.db, a.ctx, credit.id);
    expect((await listUnreconciled(h.db, a.ctx, bankId)).length).toBe(3);
  });

  it("la base protège les lignes de relevé (seul le rapprochement évolue)", async () => {
    const [line] = await h.db.select().from(bankTransactions).where(eq(bankTransactions.companyId, a.company.id)).limit(1);
    expect(await dbError(h.db.update(bankTransactions).set({ amount: "1.00" }).where(eq(bankTransactions.id, line!.id)))).toMatch(/rapprochement/);
    expect(await dbError(h.db.delete(bankTransactions).where(eq(bankTransactions.id, line!.id)))).toMatch(/suppression interdite/);
  });

  it("soldes comptable et de relevé", async () => {
    const balances = await accountBalances(h.db, a.ctx);
    const bank = balances.find((x) => x.ledgerAccount === "512000")!;
    // Relevé : +120 − 1240 − 8,50 − 8,50 = −1137,00
    expect(bank.statementBalance).toBe("-1137.00");
    // Comptable : +120 (encaissement) − 1240 (paiement fournisseur) ; le paiement contre-passé s'annule.
    expect(bank.bookBalance).toBe("-1120.00");
  });

  it("prévision de trésorerie", async () => {
    const f = await cashForecast(h.db, a.ctx, NOW);
    expect(f.horizons.map((x) => x.days)).toEqual([30, 60, 90]);
    expect(Number(f.horizons[0]!.outgoing)).toBeGreaterThan(0);
  });

  it("isolation : une autre entreprise ne peut ni importer sur ce compte ni rapprocher", async () => {
    await expect(importBankStatement(h.db, b.ctx, bankId, statement)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [line] = await h.db.select().from(bankTransactions).where(eq(bankTransactions.companyId, a.company.id)).limit(1);
    await expect(unreconcile(h.db, b.ctx, line!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await verifyAuditChain(h.db, a.company.id)).valid).toBe(true);
  });
});

void updateCompany;
