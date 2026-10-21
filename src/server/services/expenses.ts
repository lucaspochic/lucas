import { createHash } from "node:crypto";
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { Db, Executor, Tx } from "../db/client";
import { companies, expenseLines, expensePayments, expenses, idempotencyKeys, thirdParties, type Expense } from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { canonicalJson } from "../security/canonical-json";
import { D, dec, roundMoney } from "../domain/money";
import { fiscalYearOf, todayInParis } from "../domain/numbering";
import { addDays } from "../domain/sales";
import { appendAuditEvent } from "./audit";
import { allocateDocumentNumber } from "./sequences";
import { likePattern, PAGE_SIZE, type ListParams } from "./listing";
import { isUuid } from "./third-parties";
import { resolveTreasuryAccount } from "./treasury";
import { postExpense, postExpensePayment } from "./accounting";
import { EXPENSE_CATEGORIES, expensePaymentSchema, expenseSchema, reversalSchema, type ExpenseData } from "@/lib/schemas";

/**
 * Dépenses (factures fournisseurs) et paiements fournisseurs.
 *  - brouillon modifiable → validation (n° interne ACH-AAAA-NNNNN, figée par trigger) ;
 *  - la TVA est celle de la facture du fournisseur : saisie libre dans une tolérance de
 *    0,05 € (ou 1 %) autour du montant calculé, pour absorber les arrondis du fournisseur ;
 *  - paiements fournisseurs en ajout seul, idempotents, contre-passables ;
 *  - jamais plus que le reste à payer.
 */

function scoped(ctx: CompanyContext, id: string) {
  if (!isUuid(id)) throw notFound("Dépense introuvable.");
  return and(eq(expenses.companyId, ctx.companyId), eq(expenses.id, id));
}

export function computeExpenseLines(data: ExpenseData) {
  return data.lines.map((l, i) => {
    const computed = roundMoney(dec(l.amountExclTax).times(dec(l.vatRate)).dividedBy(100));
    let vat = computed;
    if (l.vatAmount !== null && l.vatAmount !== undefined) {
      const given = dec(l.vatAmount);
      const tolerance = D.max(new D("0.05"), computed.times("0.01"));
      if (given.minus(computed).abs().greaterThan(tolerance)) {
        throw new AppError(
          "VALIDATION",
          `Ligne ${i + 1} : TVA saisie (${given.toFixed(2)} €) trop éloignée de la TVA calculée (${computed.toFixed(2)} €).`,
        );
      }
      vat = given;
    }
    return {
      position: i + 1,
      category: l.category,
      ledgerAccount: EXPENSE_CATEGORIES[l.category].account,
      description: l.description,
      amountExclTax: dec(l.amountExclTax).toFixed(2),
      vatRate: dec(l.vatRate).toFixed(2),
      vatAmount: vat.toFixed(2),
    };
  });
}

async function assertSupplier(tx: Executor, ctx: CompanyContext, id: string) {
  const [party] = await tx
    .select()
    .from(thirdParties)
    .where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.id, id)))
    .limit(1);
  if (!party || !party.isSupplier) throw new AppError("VALIDATION", "Fournisseur inconnu.", { thirdPartyId: "Fournisseur inconnu." });
  return party;
}

async function writeContent(tx: Tx, ctx: CompanyContext, id: string, data: ExpenseData) {
  const lines = computeExpenseLines(data);
  const ht = lines.reduce((acc, l) => acc.plus(l.amountExclTax), new D(0));
  const vat = lines.reduce((acc, l) => acc.plus(l.vatAmount), new D(0));
  await tx.delete(expenseLines).where(eq(expenseLines.expenseId, id));
  await tx.insert(expenseLines).values(lines.map((l) => ({ ...l, companyId: ctx.companyId, expenseId: id })));
  await tx
    .update(expenses)
    .set({
      thirdPartyId: data.thirdPartyId,
      supplierReference: data.supplierReference ?? null,
      invoiceDate: data.invoiceDate,
      dueDate: data.dueDate ?? null,
      notes: data.notes ?? null,
      totalExclTax: ht.toFixed(2),
      totalVat: vat.toFixed(2),
      totalInclTax: ht.plus(vat).toFixed(2),
      updatedAt: new Date(),
    })
    .where(scoped(ctx, id));
  return { totalInclTax: ht.plus(vat).toFixed(2) };
}

export async function createExpense(db: Db, ctx: CompanyContext, raw: unknown) {
  assertPermission(ctx, "purchases.write");
  const data = expenseSchema.parse(raw);
  return db.transaction(async (tx) => {
    await assertSupplier(tx, ctx, data.thirdPartyId);
    const [row] = await tx
      .insert(expenses)
      .values({ companyId: ctx.companyId, thirdPartyId: data.thirdPartyId, invoiceDate: data.invoiceDate, createdBy: ctx.userId })
      .returning();
    const { totalInclTax } = await writeContent(tx, ctx, row!.id, data);
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "expense.draft_created",
      entityType: "expense",
      entityId: row!.id,
      payload: { totalInclTax },
    });
    return row!;
  });
}

export async function updateExpense(db: Db, ctx: CompanyContext, id: string, raw: unknown) {
  assertPermission(ctx, "purchases.write");
  const data = expenseSchema.parse(raw);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(expenses).where(scoped(ctx, id)).for("update").limit(1);
    if (!row) throw notFound("Dépense introuvable.");
    if (row.status !== "draft") throw new AppError("IMMUTABLE", "Dépense validée : elle ne peut plus être modifiée.");
    await assertSupplier(tx, ctx, data.thirdPartyId);
    const { totalInclTax } = await writeContent(tx, ctx, id, data);
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "expense.draft_updated",
      entityType: "expense",
      entityId: id,
      payload: { totalInclTax },
    });
  });
}

export async function deleteExpenseDraft(db: Db, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "purchases.write");
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(expenses).where(scoped(ctx, id)).for("update").limit(1);
    if (!row) throw notFound("Dépense introuvable.");
    if (row.status !== "draft") throw new AppError("IMMUTABLE", "Dépense validée : suppression impossible.");
    await tx.delete(expenses).where(scoped(ctx, id));
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "expense.draft_deleted",
      entityType: "expense",
      entityId: id,
      payload: { totalInclTax: row.totalInclTax },
    });
  });
}

export async function validateExpense(db: Db, ctx: CompanyContext, id: string, opts: { now?: Date } = {}) {
  assertPermission(ctx, "purchases.write");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(expenses).where(scoped(ctx, id)).for("update").limit(1);
    if (!row) throw notFound("Dépense introuvable.");
    if (row.status !== "draft") throw new AppError("IMMUTABLE", "Dépense déjà validée.");
    const today = todayInParis(opts.now);
    if (row.invoiceDate > today) throw new AppError("VALIDATION", "La date de la facture fournisseur ne peut pas être dans le futur.");
    const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(expenseLines).where(eq(expenseLines.expenseId, id));
    if (n === 0) throw new AppError("VALIDATION", "La dépense ne comporte aucune ligne.");
    const [company] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
    const fiscalYear = fiscalYearOf(row.invoiceDate, company!.fiscalYearStartMonth);
    const { number } = await allocateDocumentNumber(tx, { companyId: ctx.companyId, documentType: "purchase", fiscalYear, prefix: "ACH" });
    const [validated] = await tx
      .update(expenses)
      .set({
        status: "validated",
        number,
        fiscalYear,
        dueDate: row.dueDate ?? addDays(row.invoiceDate, 30),
        validatedAt: new Date(),
        validatedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .where(scoped(ctx, id))
      .returning();
    await postExpense(tx, company!, {
      expense: validated!,
      lines: await tx.select().from(expenseLines).where(eq(expenseLines.expenseId, id)).orderBy(asc(expenseLines.position)),
      supplier: await assertSupplierRow(tx, ctx, id),
    });
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "expense.validated",
      entityType: "expense",
      entityId: id,
      payload: { number, totalExclTax: row.totalExclTax, totalVat: row.totalVat, totalInclTax: row.totalInclTax, supplierReference: row.supplierReference },
    });
    return validated!;
  });
}

// ─── Paiements fournisseurs ─────────────────────────────────────────────────

async function claimKey(tx: Tx, ctx: CompanyContext, key: string, operation: string, request: unknown) {
  const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex");
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({ companyId: ctx.companyId, key, operation, requestHash })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length) return null;
  const [existing] = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.companyId, ctx.companyId), eq(idempotencyKeys.key, key)))
    .limit(1);
  if (!existing || existing.operation !== operation || existing.requestHash !== requestHash) {
    throw new AppError("CONFLICT", "Cette demande a déjà été utilisée pour une autre opération. Rechargez la page.");
  }
  return (existing.response as { id: string }).id;
}

export async function payExpense(db: Db, ctx: CompanyContext, expenseId: string, raw: unknown, opts: { now?: Date } = {}) {
  assertPermission(ctx, "purchases.write");
  const data = expensePaymentSchema.parse(raw);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const { idempotencyKey, ...request } = data;
    const previous = await claimKey(tx, ctx, idempotencyKey, "expense.pay", { expenseId, ...request });
    if (previous) {
      const [p] = await tx.select().from(expensePayments).where(eq(expensePayments.id, previous));
      return { result: p!, replayed: true };
    }
    const [expense] = await tx.select().from(expenses).where(scoped(ctx, expenseId)).for("update").limit(1);
    if (!expense) throw notFound("Dépense introuvable.");
    if (expense.status !== "validated") throw new AppError("VALIDATION", "Seule une dépense validée peut être payée.");
    if (data.paymentDate > todayInParis(now)) throw new AppError("VALIDATION", "La date du paiement ne peut pas être dans le futur.");
    const remaining = dec(expense.totalInclTax).minus(expense.amountPaid);
    if (dec(data.amount).greaterThan(remaining)) {
      throw new AppError("VALIDATION", `Le paiement (${data.amount} €) dépasse le reste à payer (${remaining.toFixed(2)} €).`);
    }
    const account = await resolveTreasuryAccount(tx, ctx, data.method, data.bankAccountId);
    const [company] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
    const fiscalYear = fiscalYearOf(todayInParis(now), company!.fiscalYearStartMonth);
    const { number } = await allocateDocumentNumber(tx, { companyId: ctx.companyId, documentType: "supplier_payment", fiscalYear, prefix: "PF" });
    const [payment] = await tx
      .insert(expensePayments)
      .values({
        companyId: ctx.companyId,
        number,
        expenseId,
        bankAccountId: account.id,
        paymentDate: data.paymentDate,
        method: data.method,
        amount: dec(data.amount).toFixed(2),
        reference: data.reference ?? null,
        recordedAt: now,
        createdBy: ctx.userId,
      })
      .returning();
    await tx
      .update(expenses)
      .set({ amountPaid: sql`${expenses.amountPaid} + ${payment!.amount}::numeric`, updatedAt: new Date() })
      .where(scoped(ctx, expenseId));
    await postExpensePayment(tx, company!, { payment: payment!, expense, supplier: await assertSupplierRow(tx, ctx, expenseId) });
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "expense.paid",
      entityType: "expense",
      entityId: expenseId,
      payload: { number, amount: payment!.amount, method: payment!.method, expense: expense.number },
    });
    await tx
      .update(idempotencyKeys)
      .set({ response: { id: payment!.id } })
      .where(and(eq(idempotencyKeys.companyId, ctx.companyId), eq(idempotencyKeys.key, idempotencyKey)));
    return { result: payment!, replayed: false };
  });
}

export async function reverseExpensePayment(db: Db, ctx: CompanyContext, paymentId: string, raw: unknown, opts: { now?: Date } = {}) {
  assertPermission(ctx, "purchases.write");
  if (!isUuid(paymentId)) throw notFound("Paiement introuvable.");
  const data = reversalSchema.parse(raw);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const previous = await claimKey(tx, ctx, data.idempotencyKey, "expense.reverse", { paymentId, reason: data.reason });
    if (previous) {
      const [p] = await tx.select().from(expensePayments).where(eq(expensePayments.id, previous));
      return { result: p!, replayed: true };
    }
    const [original] = await tx
      .select()
      .from(expensePayments)
      .where(and(eq(expensePayments.companyId, ctx.companyId), eq(expensePayments.id, paymentId)))
      .limit(1);
    if (!original) throw notFound("Paiement introuvable.");
    if (original.reversesId) throw new AppError("VALIDATION", "Une contre-passation ne se contre-passe pas.");
    const [already] = await tx.select({ id: expensePayments.id }).from(expensePayments).where(eq(expensePayments.reversesId, original.id)).limit(1);
    if (already) throw new AppError("CONFLICT", "Ce paiement a déjà été contre-passé.");
    await tx.select().from(expenses).where(scoped(ctx, original.expenseId)).for("update");
    const [company] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
    const fiscalYear = fiscalYearOf(todayInParis(now), company!.fiscalYearStartMonth);
    const { number } = await allocateDocumentNumber(tx, { companyId: ctx.companyId, documentType: "supplier_payment", fiscalYear, prefix: "PF" });
    const [reversal] = await tx
      .insert(expensePayments)
      .values({
        companyId: ctx.companyId,
        number,
        expenseId: original.expenseId,
        bankAccountId: original.bankAccountId,
        paymentDate: todayInParis(now),
        method: original.method,
        amount: dec(original.amount).negated().toFixed(2),
        reference: original.number,
        reversesId: original.id,
        reason: data.reason,
        recordedAt: now,
        createdBy: ctx.userId,
      })
      .returning();
    await tx
      .update(expenses)
      .set({ amountPaid: sql`${expenses.amountPaid} + ${reversal!.amount}::numeric`, updatedAt: new Date() })
      .where(scoped(ctx, original.expenseId));
    await postExpensePayment(tx, company!, { payment: reversal!, expense: (await tx.select().from(expenses).where(scoped(ctx, original.expenseId)))[0]!, supplier: await assertSupplierRow(tx, ctx, original.expenseId) });
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "expense.payment_reversed",
      entityType: "expense",
      entityId: original.expenseId,
      payload: { number, reverses: original.number, amount: reversal!.amount, reason: data.reason },
    });
    await tx
      .update(idempotencyKeys)
      .set({ response: { id: reversal!.id } })
      .where(and(eq(idempotencyKeys.companyId, ctx.companyId), eq(idempotencyKeys.key, data.idempotencyKey)));
    return { result: reversal!, replayed: false };
  });
}

// ─── Lecture ────────────────────────────────────────────────────────────────

export const EXPENSE_SORTS = ["date", "numero", "montant"] as const;
export type ExpenseStatusFilter = "draft" | "to_pay" | "paid";

export async function listExpenses(
  db: Executor,
  ctx: CompanyContext,
  f: Omit<ListParams<(typeof EXPENSE_SORTS)[number]>, "archived"> & { status?: ExpenseStatusFilter },
) {
  assertPermission(ctx, "purchases.read");
  const conditions: SQL[] = [eq(expenses.companyId, ctx.companyId)];
  if (f.status === "draft") conditions.push(eq(expenses.status, "draft"));
  if (f.status === "to_pay") conditions.push(and(eq(expenses.status, "validated"), sql`${expenses.amountPaid} < ${expenses.totalInclTax}`)!);
  if (f.status === "paid") conditions.push(and(eq(expenses.status, "validated"), sql`${expenses.amountPaid} >= ${expenses.totalInclTax}`)!);
  if (f.q) {
    const p = likePattern(f.q);
    conditions.push(or(ilike(expenses.number, p), ilike(expenses.supplierReference, p), ilike(thirdParties.name, p))!);
  }
  const where = and(...conditions);
  const column = { date: expenses.invoiceDate, numero: expenses.number, montant: expenses.totalInclTax }[f.sort];
  const join = and(eq(thirdParties.id, expenses.thirdPartyId), eq(thirdParties.companyId, expenses.companyId));
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({ e: expenses, partyName: thirdParties.name })
      .from(expenses)
      .innerJoin(thirdParties, join)
      .where(where)
      .orderBy(f.dir === "desc" ? desc(column) : asc(column), desc(expenses.createdAt))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(expenses).innerJoin(thirdParties, join).where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r.e, partyName: r.partyName })), total, pageSize: PAGE_SIZE };
}

export async function getExpense(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "purchases.read");
  const [row] = await db
    .select({ e: expenses, partyName: thirdParties.name, partyCode: thirdParties.code })
    .from(expenses)
    .innerJoin(thirdParties, and(eq(thirdParties.id, expenses.thirdPartyId), eq(thirdParties.companyId, expenses.companyId)))
    .where(scoped(ctx, id))
    .limit(1);
  if (!row) throw notFound("Dépense introuvable.");
  const [lines, pays] = await Promise.all([
    db.select().from(expenseLines).where(eq(expenseLines.expenseId, id)).orderBy(asc(expenseLines.position)),
    db.select().from(expensePayments).where(eq(expensePayments.expenseId, id)).orderBy(asc(expensePayments.recordedAt)),
  ]);
  return { expense: row.e as Expense, partyName: row.partyName, partyCode: row.partyCode, lines, payments: pays };
}

export async function listSupplierOptions(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "purchases.read");
  return db
    .select({ id: thirdParties.id, code: thirdParties.code, name: thirdParties.name })
    .from(thirdParties)
    .where(and(eq(thirdParties.companyId, ctx.companyId), eq(thirdParties.isSupplier, true), sql`${thirdParties.archivedAt} is null`))
    .orderBy(asc(sql`lower(${thirdParties.name})`))
    .limit(1000);
}

/** Total HT des dépenses validées sur une période (tableau de bord). */
export async function expensesTotal(db: Executor, ctx: CompanyContext, from: string, to: string) {
  const [r] = await db
    .select({ ht: sql<string>`coalesce(sum(${expenses.totalExclTax}), 0)::text` })
    .from(expenses)
    .where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.status, "validated"), sql`${expenses.invoiceDate} between ${from} and ${to}`));
  return dec(r!.ht).toFixed(2);
}

/** Fournisseur d'une dépense (pour la comptabilisation). */
async function assertSupplierRow(tx: Executor, ctx: CompanyContext, expenseId: string) {
  const [row] = await tx
    .select({ party: thirdParties })
    .from(expenses)
    .innerJoin(thirdParties, and(eq(thirdParties.id, expenses.thirdPartyId), eq(thirdParties.companyId, expenses.companyId)))
    .where(scoped(ctx, expenseId))
    .limit(1);
  return row!.party;
}
