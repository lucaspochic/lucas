import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db, Executor } from "../db/client";
import { bankAccounts, bankTransactions, expensePayments, expenses, payments, thirdParties, type BankAccount } from "../db/schema";
import { AppError, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { D, dec } from "../domain/money";
import { addDays } from "../domain/sales";
import { todayInParis } from "../domain/numbering";
import { csvToRecords, CsvError, parseFrenchDecimal } from "../domain/csv";
import { appendAuditEvent } from "./audit";
import { invoiceBalances } from "./payments";
import { isUuid } from "./third-parties";
import { bankAccountSchema } from "@/lib/schemas";

/**
 * Trésorerie : comptes (banque 512 / caisse 530), relevés importés, rapprochement, prévision.
 *
 * Deux soldes par compte, à ne pas confondre :
 *  - solde comptable : ouverture + règlements clients − paiements fournisseurs enregistrés ;
 *  - solde du relevé : ouverture + lignes de relevé importées.
 * L'écart provient des opérations non encore rapprochées.
 */

// ─── Comptes ────────────────────────────────────────────────────────────────

/** Compte à utiliser pour un règlement : espèces → caisse ; autres modes → banque. */
export async function resolveTreasuryAccount(
  tx: Executor,
  ctx: CompanyContext,
  method: string,
  bankAccountId?: string | null,
): Promise<BankAccount> {
  const kind = method === "cash" ? "cash" : "bank";
  const conditions = [eq(bankAccounts.companyId, ctx.companyId), isNull(bankAccounts.archivedAt), eq(bankAccounts.kind, kind)];
  if (bankAccountId) {
    if (!isUuid(bankAccountId)) throw new AppError("VALIDATION", "Compte de trésorerie inconnu.");
    conditions.push(eq(bankAccounts.id, bankAccountId));
  } else conditions.push(eq(bankAccounts.isDefault, true));
  const [account] = await tx.select().from(bankAccounts).where(and(...conditions)).limit(1);
  if (!account) {
    throw new AppError(
      "VALIDATION",
      kind === "cash"
        ? "Aucun compte de caisse actif pour un règlement en espèces (Trésorerie › Comptes)."
        : "Compte bancaire inconnu, archivé ou incompatible avec ce mode de paiement.",
    );
  }
  return account;
}

export async function createDefaultTreasuryAccounts(tx: Executor, companyId: string, openingDate: string) {
  await tx.insert(bankAccounts).values([
    { companyId, kind: "bank", name: "Compte courant", openingDate, ledgerAccount: "512000", isDefault: true },
    { companyId, kind: "cash", name: "Caisse", openingDate, ledgerAccount: "530000", isDefault: true },
  ]);
}

export async function listBankAccounts(db: Executor, ctx: CompanyContext, opts: { includeArchived?: boolean } = {}) {
  assertPermission(ctx, "treasury.read");
  const conditions = [eq(bankAccounts.companyId, ctx.companyId)];
  if (!opts.includeArchived) conditions.push(isNull(bankAccounts.archivedAt));
  return db.select().from(bankAccounts).where(and(...conditions)).orderBy(asc(bankAccounts.kind), asc(bankAccounts.ledgerAccount));
}

/** Comptes actifs proposés dans les formulaires de règlement (lecture minimale). */
export async function treasuryAccountOptions(db: Executor, ctx: CompanyContext) {
  return db
    .select({ id: bankAccounts.id, name: bankAccounts.name, kind: bankAccounts.kind, isDefault: bankAccounts.isDefault })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, ctx.companyId), isNull(bankAccounts.archivedAt)))
    .orderBy(asc(bankAccounts.kind), asc(bankAccounts.ledgerAccount));
}

export async function createBankAccount(db: Db, ctx: CompanyContext, raw: unknown) {
  assertPermission(ctx, "treasury.write");
  const data = bankAccountSchema.parse(raw);
  return db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.ledgerAccount, data.ledgerAccount)))
      .limit(1);
    if (dup) throw new AppError("CONFLICT", "Ce compte comptable est déjà utilisé.", { ledgerAccount: "Déjà utilisé." });
    const [account] = await tx
      .insert(bankAccounts)
      .values({ ...data, openingBalance: dec(data.openingBalance).toFixed(2), companyId: ctx.companyId, isDefault: false })
      .returning();
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "bank_account.created",
      entityType: "bank_account",
      entityId: account!.id,
      payload: { name: account!.name, ledgerAccount: account!.ledgerAccount, openingBalance: account!.openingBalance },
    });
    return account!;
  });
}

export async function setDefaultBankAccount(db: Db, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "treasury.write");
  if (!isUuid(id)) throw notFound("Compte introuvable.");
  await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.id, id), isNull(bankAccounts.archivedAt)))
      .limit(1);
    if (!account) throw notFound("Compte introuvable.");
    await tx
      .update(bankAccounts)
      .set({ isDefault: false })
      .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.kind, account.kind)));
    await tx.update(bankAccounts).set({ isDefault: true }).where(eq(bankAccounts.id, id));
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "bank_account.default_set",
      entityType: "bank_account",
      entityId: id,
      payload: { name: account.name },
    });
  });
}

/** Soldes comptable et de relevé de chaque compte, à date. */
export async function accountBalances(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "treasury.read");
  const accounts = await listBankAccounts(db, ctx);
  if (accounts.length === 0) return [];
  const ids = accounts.map((a) => a.id);
  const [received, paid, statement, unreconciled] = await Promise.all([
    db
      .select({ id: payments.bankAccountId, total: sql<string>`sum(${payments.amount})::text` })
      .from(payments)
      .where(and(eq(payments.companyId, ctx.companyId), inArray(payments.bankAccountId, ids)))
      .groupBy(payments.bankAccountId),
    db
      .select({ id: expensePayments.bankAccountId, total: sql<string>`sum(${expensePayments.amount})::text` })
      .from(expensePayments)
      .where(and(eq(expensePayments.companyId, ctx.companyId), inArray(expensePayments.bankAccountId, ids)))
      .groupBy(expensePayments.bankAccountId),
    db
      .select({ id: bankTransactions.bankAccountId, total: sql<string>`sum(${bankTransactions.amount})::text`, last: sql<string>`max(${bankTransactions.operationDate})` })
      .from(bankTransactions)
      .where(and(eq(bankTransactions.companyId, ctx.companyId), inArray(bankTransactions.bankAccountId, ids)))
      .groupBy(bankTransactions.bankAccountId),
    db
      .select({ id: bankTransactions.bankAccountId, n: sql<number>`count(*)::int` })
      .from(bankTransactions)
      .where(and(eq(bankTransactions.companyId, ctx.companyId), isNull(bankTransactions.reconciledAt)))
      .groupBy(bankTransactions.bankAccountId),
  ]);
  const val = (rows: { id: string | null; total: string }[], id: string) => dec(rows.find((r) => r.id === id)?.total ?? "0");
  return accounts.map((a) => {
    const st = statement.find((s) => s.id === a.id);
    return {
      ...a,
      bookBalance: dec(a.openingBalance).plus(val(received, a.id)).minus(val(paid, a.id)).toFixed(2),
      statementBalance: st ? dec(a.openingBalance).plus(st.total).toFixed(2) : null,
      lastStatementDate: st?.last ?? null,
      unreconciled: unreconciled.find((u) => u.id === a.id)?.n ?? 0,
    };
  });
}

// ─── Import de relevés ──────────────────────────────────────────────────────

/** « 21/10/2026 », « 2026-10-21 », « 21-10-26 » → « 2026-10-21 ». */
export function parseStatementDate(value: string): string | null {
  const v = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(v);
  if (!m) return null;
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  const iso = `${year}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

export interface StatementImportReport {
  imported: number;
  duplicates: number;
  errors: { line: number; message: string }[];
}

/**
 * Importe un relevé CSV (date ; libellé ; montant — ou débit / crédit).
 * Dédoublonnage : empreinte (date, montant, libellé normalisé, rang de la ligne identique
 * dans le fichier). Réimporter un relevé ou un relevé qui chevauche le précédent ne crée
 * aucun doublon. Tout ou rien : la moindre ligne invalide annule l'import.
 */
export async function importBankStatement(db: Db, ctx: CompanyContext, bankAccountId: string, content: string): Promise<StatementImportReport> {
  assertPermission(ctx, "treasury.write");
  if (!isUuid(bankAccountId)) throw notFound("Compte introuvable.");
  let records: Record<string, string>[];
  try {
    ({ records } = csvToRecords(content));
  } catch (e) {
    if (e instanceof CsvError) throw new AppError("VALIDATION", e.message);
    throw e;
  }
  if (records.length === 0) throw new AppError("VALIDATION", "Le relevé est vide.");
  if (records.length > 5000) throw new AppError("VALIDATION", "5 000 lignes au maximum par import.");

  const pick = (r: Record<string, string>, ...keys: string[]) => keys.map((k) => r[k]).find((v) => v !== undefined && v !== "");
  const errors: StatementImportReport["errors"] = [];
  const rows: { operationDate: string; label: string; amount: string; key: string }[] = [];
  records.forEach((r, i) => {
    const line = i + 2;
    const date = parseStatementDate(pick(r, "date", "date_operation", "date_de_l_operation", "date_valeur") ?? "");
    const label = (pick(r, "libelle", "label", "libelle_operation", "description") ?? "").replace(/\s+/g, " ").trim();
    let amount: string | null = null;
    const single = pick(r, "montant", "amount", "montant_eur");
    if (single !== undefined) amount = parseFrenchDecimal(single);
    else {
      const debit = parseFrenchDecimal(pick(r, "debit", "debit_eur") ?? "") ?? "0";
      const credit = parseFrenchDecimal(pick(r, "credit", "credit_eur") ?? "") ?? "0";
      amount = dec(credit).minus(dec(debit).abs()).toFixed(2);
    }
    if (!date) return errors.push({ line, message: "date : format attendu JJ/MM/AAAA ou AAAA-MM-JJ." });
    if (!label) return errors.push({ line, message: "libellé manquant." });
    if (amount === null || dec(amount).isZero()) return errors.push({ line, message: "montant invalide ou nul." });
    if (dec(amount).decimalPlaces() > 2) return errors.push({ line, message: "montant : 2 décimales au maximum." });
    rows.push({ operationDate: date, label, amount: dec(amount).toFixed(2), key: `${date}|${dec(amount).toFixed(2)}|${label.toLowerCase()}` });
  });
  if (errors.length) return { imported: 0, duplicates: 0, errors };

  return db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.id, bankAccountId), isNull(bankAccounts.archivedAt)))
      .limit(1);
    if (!account) throw notFound("Compte introuvable.");
    if (account.kind !== "bank") throw new AppError("VALIDATION", "Les relevés s'importent sur un compte bancaire.");
    const importId = crypto.randomUUID();
    const seen = new Map<string, number>();
    const values = rows.map((r) => {
      const rank = (seen.get(r.key) ?? 0) + 1;
      seen.set(r.key, rank);
      const fingerprint = createHash("sha256").update(`${r.key}|${rank}`).digest("hex");
      return { companyId: ctx.companyId, bankAccountId, operationDate: r.operationDate, label: r.label, amount: r.amount, fingerprint, importId };
    });
    const inserted = await tx.insert(bankTransactions).values(values).onConflictDoNothing().returning({ id: bankTransactions.id });
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "bank_statement.imported",
      entityType: "bank_account",
      entityId: bankAccountId,
      payload: { importId, lines: rows.length, imported: inserted.length, duplicates: rows.length - inserted.length },
    });
    return { imported: inserted.length, duplicates: rows.length - inserted.length, errors: [] };
  });
}

// ─── Rapprochement ──────────────────────────────────────────────────────────

export async function listUnreconciled(db: Executor, ctx: CompanyContext, bankAccountId: string) {
  assertPermission(ctx, "treasury.read");
  if (!isUuid(bankAccountId)) return [];
  const lines = await db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.bankAccountId, bankAccountId), isNull(bankTransactions.reconciledAt)))
    .orderBy(desc(bankTransactions.operationDate))
    .limit(200);
  if (lines.length === 0) return [];
  // Candidats : règlements du même compte, non encore rapprochés, même montant, ±10 jours.
  const [custPayments, supPayments] = await Promise.all([
    db
      .select({ id: payments.id, number: payments.number, date: payments.paymentDate, amount: payments.amount, party: thirdParties.name })
      .from(payments)
      .innerJoin(thirdParties, and(eq(thirdParties.id, payments.thirdPartyId), eq(thirdParties.companyId, payments.companyId)))
      .leftJoin(bankTransactions, eq(bankTransactions.matchedPaymentId, payments.id))
      .where(and(eq(payments.companyId, ctx.companyId), eq(payments.bankAccountId, bankAccountId), isNull(bankTransactions.id))),
    db
      .select({ id: expensePayments.id, number: expensePayments.number, date: expensePayments.paymentDate, amount: expensePayments.amount, party: thirdParties.name })
      .from(expensePayments)
      .innerJoin(expenses, eq(expenses.id, expensePayments.expenseId))
      .innerJoin(thirdParties, and(eq(thirdParties.id, expenses.thirdPartyId), eq(thirdParties.companyId, expenses.companyId)))
      .leftJoin(bankTransactions, eq(bankTransactions.matchedExpensePaymentId, expensePayments.id))
      .where(and(eq(expensePayments.companyId, ctx.companyId), eq(expensePayments.bankAccountId, bankAccountId), isNull(bankTransactions.id))),
  ]);
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 10 * 86_400_000;
  return lines.map((l) => ({
    ...l,
    candidates: [
      ...custPayments
        .filter((p) => dec(p.amount).equals(dec(l.amount)) && near(p.date, l.operationDate))
        .map((p) => ({ type: "payment" as const, ...p })),
      ...supPayments
        // Un paiement fournisseur sort de la banque : montant opposé sur le relevé.
        .filter((p) => dec(p.amount).negated().equals(dec(l.amount)) && near(p.date, l.operationDate))
        .map((p) => ({ type: "expense_payment" as const, ...p })),
    ],
  }));
}

export async function reconcile(
  db: Db,
  ctx: CompanyContext,
  transactionId: string,
  target: { type: "payment" | "expense_payment"; id: string },
) {
  assertPermission(ctx, "treasury.write");
  if (!isUuid(transactionId) || !isUuid(target.id)) throw notFound("Élément introuvable.");
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select()
      .from(bankTransactions)
      .where(and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.id, transactionId)))
      .for("update")
      .limit(1);
    if (!line) throw notFound("Ligne de relevé introuvable.");
    if (line.reconciledAt) throw new AppError("CONFLICT", "Cette ligne est déjà rapprochée.");
    let amountMatches = false;
    let number: string;
    if (target.type === "payment") {
      const [p] = await tx.select().from(payments).where(and(eq(payments.companyId, ctx.companyId), eq(payments.id, target.id))).limit(1);
      if (!p || p.bankAccountId !== line.bankAccountId) throw new AppError("VALIDATION", "Règlement inconnu ou sur un autre compte.");
      amountMatches = dec(p.amount).equals(dec(line.amount));
      number = p.number;
    } else {
      const [p] = await tx
        .select()
        .from(expensePayments)
        .where(and(eq(expensePayments.companyId, ctx.companyId), eq(expensePayments.id, target.id)))
        .limit(1);
      if (!p || p.bankAccountId !== line.bankAccountId) throw new AppError("VALIDATION", "Paiement inconnu ou sur un autre compte.");
      amountMatches = dec(p.amount).negated().equals(dec(line.amount));
      number = p.number;
    }
    if (!amountMatches) throw new AppError("VALIDATION", "Les montants ne correspondent pas.");
    try {
      await tx
        .update(bankTransactions)
        .set({
          matchedPaymentId: target.type === "payment" ? target.id : null,
          matchedExpensePaymentId: target.type === "expense_payment" ? target.id : null,
          reconciledAt: new Date(),
          reconciledBy: ctx.userId,
        })
        .where(eq(bankTransactions.id, transactionId));
    } catch {
      throw new AppError("CONFLICT", "Ce règlement est déjà rapproché d'une autre ligne.");
    }
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "bank_transaction.reconciled",
      entityType: "bank_transaction",
      entityId: transactionId,
      payload: { with: number, amount: line.amount, date: line.operationDate },
    });
  });
}

export async function unreconcile(db: Db, ctx: CompanyContext, transactionId: string) {
  assertPermission(ctx, "treasury.write");
  if (!isUuid(transactionId)) throw notFound("Ligne introuvable.");
  await db.transaction(async (tx) => {
    const [line] = await tx
      .update(bankTransactions)
      .set({ matchedPaymentId: null, matchedExpensePaymentId: null, reconciledAt: null, reconciledBy: null })
      .where(and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.id, transactionId), sql`${bankTransactions.reconciledAt} is not null`))
      .returning();
    if (!line) throw notFound("Ligne introuvable ou non rapprochée.");
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "bank_transaction.unreconciled",
      entityType: "bank_transaction",
      entityId: transactionId,
      payload: { amount: line.amount, date: line.operationDate },
    });
  });
}

// ─── Prévision ──────────────────────────────────────────────────────────────

/** Encaissements attendus (créances) et décaissements prévus (dépenses à payer) par horizon. */
export async function cashForecast(db: Executor, ctx: CompanyContext, now?: Date) {
  assertPermission(ctx, "treasury.read");
  const today = todayInParis(now);
  const horizons = [30, 60, 90].map((d) => ({ days: d, until: addDays(today, d) }));
  const receivables = (await invoiceBalances(db, ctx, {}, now)).filter((b) => dec(b.remaining).greaterThan(0));
  const payables = await db
    .select({ remaining: sql<string>`(${expenses.totalInclTax} - ${expenses.amountPaid})::text`, dueDate: expenses.dueDate, invoiceDate: expenses.invoiceDate })
    .from(expenses)
    .where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.status, "validated"), sql`${expenses.totalInclTax} > ${expenses.amountPaid}`));
  const due = (list: { remaining: string; dueDate: string | null }[], until: string) =>
    list.filter((x) => (x.dueDate ?? today) <= until).reduce((acc, x) => acc.plus(x.remaining), new D(0));
  const overdueIn = receivables.filter((r) => r.dueDate && r.dueDate < today).reduce((acc, r) => acc.plus(r.remaining), new D(0));
  const overdueOut = payables.filter((p) => (p.dueDate ?? p.invoiceDate) < today).reduce((acc, p) => acc.plus(p.remaining), new D(0));
  return {
    today,
    overdue: { incoming: overdueIn.toFixed(2), outgoing: overdueOut.toFixed(2) },
    horizons: horizons.map((h) => {
      const incoming = due(receivables, h.until);
      const outgoing = due(payables.map((p) => ({ remaining: p.remaining, dueDate: p.dueDate ?? p.invoiceDate })), h.until);
      return { days: h.days, incoming: incoming.toFixed(2), outgoing: outgoing.toFixed(2), net: incoming.minus(outgoing).toFixed(2) };
    }),
  };
}

/** Dernières lignes rapprochées d'un compte (avec le n° du règlement associé). */
export async function listReconciled(db: Executor, ctx: CompanyContext, bankAccountId: string, limit = 20) {
  assertPermission(ctx, "treasury.read");
  if (!isUuid(bankAccountId)) return [];
  return db
    .select({
      id: bankTransactions.id,
      operationDate: bankTransactions.operationDate,
      label: bankTransactions.label,
      amount: bankTransactions.amount,
      paymentNumber: payments.number,
      expensePaymentNumber: expensePayments.number,
    })
    .from(bankTransactions)
    .leftJoin(payments, eq(payments.id, bankTransactions.matchedPaymentId))
    .leftJoin(expensePayments, eq(expensePayments.id, bankTransactions.matchedExpensePaymentId))
    .where(and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.bankAccountId, bankAccountId), sql`${bankTransactions.reconciledAt} is not null`))
    .orderBy(desc(bankTransactions.operationDate))
    .limit(limit);
}

export async function getBankAccount(db: Executor, ctx: CompanyContext, id: string) {
  assertPermission(ctx, "treasury.read");
  if (!isUuid(id)) throw notFound("Compte introuvable.");
  const [account] = await db.select().from(bankAccounts).where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.id, id))).limit(1);
  if (!account) throw notFound("Compte introuvable.");
  return account;
}
