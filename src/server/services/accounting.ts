import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { Executor, Tx } from "../db/client";
import {
  bankAccounts,
  companies,
  fiscalYearClosures,
  journalEntries,
  journalLines,
  journals,
  ledgerAccounts,
  salesDocuments,
  type BankAccount,
  type Company,
  type Expense,
  type ExpenseLine,
  type ExpensePayment,
  type Payment,
  type SalesDocument,
  type SalesDocumentLine,
  type ThirdParty,
} from "../db/schema";
import { D, dec, roundMoney, type Dec } from "../domain/money";
import { computeDocumentTotals } from "../domain/document-totals";
import { fiscalYearOf } from "../domain/numbering";
import { allocateYearlyCounter } from "./sequences";
import { AppError } from "../errors";

/**
 * Comptabilisation automatique (docs/12-conception-comptabilite.md).
 * Chaque fonction de ce module est appelée DANS la transaction de l'événement métier :
 * l'écriture et l'événement sont enregistrés ensemble ou pas du tout. L'équilibre de
 * chaque écriture est en outre contrôlé par la base (trigger de contrainte différé).
 */

// ─── Plan de comptes ────────────────────────────────────────────────────────

export const DEFAULT_CHART: Record<string, string> = {
  "120000": "Résultat de l'exercice (bénéfice)",
  "129000": "Résultat de l'exercice (perte)",
  "218300": "Matériel de bureau et matériel informatique",
  "401000": "Fournisseurs",
  "411000": "Clients",
  "445620": "TVA déductible sur immobilisations",
  "445660": "TVA déductible sur autres biens et services",
  "445710": "TVA collectée (autres taux)",
  "445711": "TVA collectée 20 %",
  "445712": "TVA collectée 10 %",
  "445713": "TVA collectée 5,5 %",
  "445714": "TVA collectée 2,1 %",
  "445740": "TVA collectée en attente d'encaissement (autres taux)",
  "445741": "TVA collectée en attente d'encaissement 20 %",
  "445742": "TVA collectée en attente d'encaissement 10 %",
  "445743": "TVA collectée en attente d'encaissement 5,5 %",
  "445744": "TVA collectée en attente d'encaissement 2,1 %",
  "512000": "Banque",
  "530000": "Caisse",
  "601000": "Achats stockés - matières premières",
  "606100": "Fournitures non stockables (eau, énergie)",
  "606140": "Carburant",
  "606300": "Fournitures d'entretien et de petit équipement",
  "606400": "Fournitures administratives",
  "607000": "Achats de marchandises",
  "611000": "Sous-traitance générale",
  "613200": "Locations immobilières",
  "615000": "Entretien et réparations",
  "616000": "Primes d'assurances",
  "622600": "Honoraires",
  "623000": "Publicité, publications, relations publiques",
  "624100": "Transports sur achats",
  "625100": "Voyages et déplacements",
  "626000": "Frais postaux et de télécommunications",
  "627000": "Services bancaires et assimilés",
  "628000": "Divers",
  "651000": "Redevances pour concessions, brevets, licences, logiciels",
  "658000": "Charges diverses de gestion courante (écarts de caisse)",
  "706000": "Prestations de services",
  "707000": "Ventes de marchandises",
  "758000": "Produits divers de gestion courante (écarts de caisse)",
};

const VAT_SUFFIX: Record<string, string> = { "20.00": "1", "10.00": "2", "5.50": "3", "2.10": "4" };
export const collectedVatAccount = (rate: string) => `44571${VAT_SUFFIX[dec(rate).toFixed(2)] ?? "0"}`;
export const pendingVatAccount = (rate: string) => `44574${VAT_SUFFIX[dec(rate).toFixed(2)] ?? "0"}`;
const PENDING_PREFIX = "44574";

async function ensureAccounts(tx: Tx, companyId: string, accounts: Map<string, string>) {
  const numbers = [...accounts.keys()];
  const existing = await tx
    .select({ number: ledgerAccounts.number })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.number, numbers)));
  const missing = numbers.filter((n) => !existing.some((e) => e.number === n));
  if (missing.length) {
    await tx
      .insert(ledgerAccounts)
      .values(missing.map((number) => ({ companyId, number, label: accounts.get(number) || DEFAULT_CHART[number] || `Compte ${number}` })))
      .onConflictDoNothing();
  }
}

export async function seedChartOfAccounts(tx: Tx, companyId: string) {
  await ensureAccounts(tx, companyId, new Map(Object.entries(DEFAULT_CHART)));
}

// ─── Journaux ───────────────────────────────────────────────────────────────

const FIXED_JOURNALS = {
  VE: { label: "Ventes", kind: "sales" },
  AC: { label: "Achats", kind: "purchases" },
  OD: { label: "Opérations diverses", kind: "misc" },
  VC: { label: "Ventes caisse", kind: "sales" },
  AN: { label: "À-nouveaux", kind: "misc" },
} as const;

export async function ensureJournal(tx: Tx, companyId: string, code: keyof typeof FIXED_JOURNALS) {
  await tx
    .insert(journals)
    .values({ companyId, code, label: FIXED_JOURNALS[code].label, kind: FIXED_JOURNALS[code].kind })
    .onConflictDoNothing();
  return code;
}

/** Un journal par compte de trésorerie : BQ1, BQ2… pour les banques, CA1… pour les caisses. */
async function treasuryJournal(tx: Tx, companyId: string, account: BankAccount): Promise<string> {
  const [existing] = await tx.select({ code: journals.code }).from(journals).where(eq(journals.bankAccountId, account.id)).limit(1);
  if (existing) return existing.code;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"journals:" + companyId}))`);
  const kind = account.kind === "bank" ? "bank" : "cash";
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(journals)
    .where(and(eq(journals.companyId, companyId), eq(journals.kind, kind)));
  const code = `${kind === "bank" ? "BQ" : "CA"}${n + 1}`;
  await tx.insert(journals).values({ companyId, code, label: account.name, kind, bankAccountId: account.id });
  return code;
}

// ─── Écriture générique ─────────────────────────────────────────────────────

export interface PostingLine {
  account: string;
  accountLabel?: string;
  /** Montant signé : positif = débit, négatif = crédit. Les montants nuls sont ignorés. */
  amount: Dec;
  label: string;
  aux?: { number: string; label: string };
}

export interface PostingInput {
  journalCode: string;
  entryDate: string;
  pieceRef: string;
  pieceDate: string;
  label: string;
  sourceKey: string;
  lines: PostingLine[];
}

export async function postEntry(tx: Tx, company: Company, input: PostingInput, now = new Date()) {
  const [existing] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, company.id), eq(journalEntries.sourceKey, input.sourceKey)))
    .limit(1);
  if (existing) return existing.id; // idempotent : une écriture par événement
  const lines = input.lines.filter((l) => !roundMoney(l.amount).isZero());
  if (lines.length === 0) return null;
  await ensureAccounts(tx, company.id, new Map(lines.map((l) => [l.account, l.accountLabel ?? ""])));
  const fiscalYear = fiscalYearOf(input.entryDate, company.fiscalYearStartMonth);
  const [closed] = await tx
    .select({ id: fiscalYearClosures.id })
    .from(fiscalYearClosures)
    .where(and(eq(fiscalYearClosures.companyId, company.id), eq(fiscalYearClosures.fiscalYear, fiscalYear)))
    .limit(1);
  if (closed) throw new AppError("VALIDATION", `L'exercice ${fiscalYear} est clôturé : aucune opération ne peut plus y être enregistrée (date ${input.entryDate.split("-").reverse().join("/")}).`);
  const entrySeq = await allocateYearlyCounter(tx, company.id, "journal_entry", fiscalYear);
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      companyId: company.id,
      journalCode: input.journalCode,
      fiscalYear,
      entrySeq,
      entryDate: input.entryDate,
      pieceRef: input.pieceRef,
      pieceDate: input.pieceDate,
      label: input.label.slice(0, 200),
      sourceKey: input.sourceKey,
      validatedAt: now,
    })
    .returning({ id: journalEntries.id });
  await tx.insert(journalLines).values(
    lines.map((l, i) => {
      const amt = roundMoney(l.amount);
      return {
        companyId: company.id,
        entryId: entry!.id,
        lineNo: i + 1,
        accountNumber: l.account,
        auxNumber: l.aux?.number ?? null,
        auxLabel: l.aux?.label ?? null,
        label: l.label.slice(0, 200),
        debit: amt.isPositive() ? amt.toFixed(2) : "0.00",
        credit: amt.isNegative() ? amt.negated().toFixed(2) : "0.00",
      };
    }),
  );
  return entry!.id;
}

// ─── Ventes ─────────────────────────────────────────────────────────────────

/** Ventilation HT par nature et TVA par taux (et par nature pour la TVA sur encaissements). */
export function salesBreakdown(doc: Pick<SalesDocument, "globalDiscountPercent">, lines: SalesDocumentLine[]) {
  const totals = computeDocumentTotals({
    lines: lines.map((l) => ({
      quantity: l.quantity,
      unitPriceExclTax: l.unitPriceExclTax,
      discountPercent: l.discountPercent,
      vatRate: l.vatRate,
      vatExemptionReason: l.vatExemptionReason ?? undefined,
    })),
    globalDiscountPercent: doc.globalDiscountPercent,
  });
  const htByKind = { good: new D(0), service: new D(0) };
  const serviceBaseByRate = new Map<string, Dec>();
  lines.forEach((l, i) => {
    const net = dec(totals.lines[i]!.totalExclTax);
    htByKind[l.kind] = htByKind[l.kind].plus(net);
    if (l.kind === "service") {
      const key = dec(l.vatRate).toFixed(2);
      serviceBaseByRate.set(key, (serviceBaseByRate.get(key) ?? new D(0)).plus(net));
    }
  });
  const vatByRate = new Map<string, { total: Dec; services: Dec }>();
  for (const v of totals.vatBreakdown) {
    const key = dec(v.vatRate).toFixed(2);
    const total = (vatByRate.get(key)?.total ?? new D(0)).plus(v.vatAmount);
    const servicesRaw = roundMoney((serviceBaseByRate.get(key) ?? new D(0)).times(key).dividedBy(100));
    vatByRate.set(key, { total, services: D.min(servicesRaw, total) });
  }
  return { totals, htByKind, vatByRate };
}

export async function postSalesDocument(
  tx: Tx,
  company: Company,
  input: { doc: SalesDocument; lines: SalesDocumentLine[]; party: ThirdParty; sourceNumber: string | null },
  now?: Date,
) {
  const { doc, lines, party } = input;
  if (doc.type === "quote" || doc.status === "draft") return null;
  await ensureJournal(tx, company.id, "VE");
  const sign = doc.type === "credit_note" ? -1 : 1;
  const { totals, htByKind, vatByRate } = salesBreakdown(doc, lines);
  const aux = { number: party.code, label: party.name };
  const label = doc.type === "credit_note" ? `Avoir ${doc.number} sur ${input.sourceNumber} — ${party.name}` : `Facture ${doc.number} — ${party.name}`;
  const pendingOnServices = !company.vatOnDebits;
  const vatLines: PostingLine[] = [];
  for (const [rate, v] of vatByRate) {
    const pending = pendingOnServices ? v.services : new D(0);
    vatLines.push({ account: collectedVatAccount(rate), amount: v.total.minus(pending).times(-sign), label });
    vatLines.push({ account: pendingVatAccount(rate), amount: pending.times(-sign), label });
  }
  return postEntry(
    tx,
    company,
    {
      journalCode: "VE",
      entryDate: doc.issueDate!,
      pieceRef: doc.number!,
      pieceDate: doc.issueDate!,
      label,
      sourceKey: `sales:${doc.id}`,
      lines: [
        { account: "411000", amount: dec(totals.totalInclTax).times(sign), label, aux },
        { account: "706000", amount: htByKind.service.times(-sign), label },
        { account: "707000", amount: htByKind.good.times(-sign), label },
        ...vatLines,
      ],
    },
    now,
  );
}

// ─── Règlements clients ─────────────────────────────────────────────────────

async function accountForPayment(tx: Tx, companyId: string, bankAccountId: string | null, method: string): Promise<BankAccount> {
  const conditions = bankAccountId
    ? [eq(bankAccounts.id, bankAccountId)]
    : [eq(bankAccounts.companyId, companyId), eq(bankAccounts.kind, method === "cash" ? "cash" : "bank"), eq(bankAccounts.isDefault, true)];
  const [account] = await tx.select().from(bankAccounts).where(and(...conditions)).limit(1);
  if (!account) throw new Error("Aucun compte de trésorerie pour comptabiliser le règlement.");
  return account;
}

/** Solde des comptes de TVA en attente pour une facture (facture + avoirs − transferts déjà faits). */
async function pendingVatForInvoice(tx: Tx, companyId: string, invoiceId: string) {
  const credits = await tx
    .select({ id: salesDocuments.id })
    .from(salesDocuments)
    .where(and(eq(salesDocuments.companyId, companyId), eq(salesDocuments.sourceDocumentId, invoiceId), eq(salesDocuments.type, "credit_note")));
  const salesKeys = [invoiceId, ...credits.map((c) => c.id)].map((id) => `sales:${id}`);
  const rows = await tx
    .select({
      account: journalLines.accountNumber,
      isTransfer: sql<boolean>`${journalEntries.sourceKey} like 'vat:%'`,
      net: sql<string>`sum(${journalLines.credit} - ${journalLines.debit})::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(
      and(
        eq(journalLines.companyId, companyId),
        like(journalLines.accountNumber, `${PENDING_PREFIX}%`),
        or(inArray(journalEntries.sourceKey, salesKeys), like(journalEntries.sourceKey, `vat:%:${invoiceId}`)),
      ),
    )
    .groupBy(journalLines.accountNumber, sql`2`);
  const byAccount = new Map<string, { initial: Dec; transferred: Dec }>();
  for (const r of rows) {
    const cur = byAccount.get(r.account) ?? { initial: new D(0), transferred: new D(0) };
    // Facture/avoirs : solde créditeur = TVA en attente ; transferts : débits du compte d'attente.
    if (r.isTransfer) cur.transferred = cur.transferred.plus(dec(r.net).negated());
    else cur.initial = cur.initial.plus(r.net);
    byAccount.set(r.account, cur);
  }
  return byAccount;
}

export async function postCustomerPayment(
  tx: Tx,
  company: Company,
  input: { payment: Payment; allocations: { documentId: string; amount: string }[]; party: ThirdParty },
  now?: Date,
) {
  const { payment, party } = input;
  const account = await accountForPayment(tx, company.id, payment.bankAccountId, payment.method);
  const journalCode = await treasuryJournal(tx, company.id, account);
  const amount = dec(payment.amount);
  const kindLabel = payment.kind === "reversal" ? "Contre-passation" : payment.kind === "refund" ? "Remboursement" : "Règlement";
  const label = `${kindLabel} ${payment.number} — ${party.name}`;
  const entryId = await postEntry(
    tx,
    company,
    {
      journalCode,
      entryDate: payment.paymentDate,
      pieceRef: payment.number,
      pieceDate: payment.paymentDate,
      label,
      sourceKey: `payment:${payment.id}`,
      lines: [
        { account: account.ledgerAccount, accountLabel: account.name, amount, label },
        { account: "411000", amount: amount.negated(), label, aux: { number: party.code, label: party.name } },
      ],
    },
    now,
  );

  // TVA sur encaissements (prestations sans option sur les débits) : transfert de la quote-part encaissée.
  if (company.vatOnDebits || company.vatRegime === "franchise_en_base") return entryId;
  await ensureJournal(tx, company.id, "OD");
  for (const alloc of input.allocations) {
    const [invoice] = await tx
      .select()
      .from(salesDocuments)
      .where(and(eq(salesDocuments.companyId, company.id), eq(salesDocuments.id, alloc.documentId)))
      .limit(1);
    if (!invoice) continue;
    const pending = await pendingVatForInvoice(tx, company.id, invoice.id);
    if (pending.size === 0) continue;
    const credited = await tx
      .select({ total: sql<string>`coalesce(sum(${salesDocuments.totalInclTax}), 0)::text` })
      .from(salesDocuments)
      .where(and(eq(salesDocuments.companyId, company.id), eq(salesDocuments.sourceDocumentId, invoice.id), eq(salesDocuments.type, "credit_note"), sql`${salesDocuments.status} <> 'draft'`));
    const netDue = dec(invoice.totalInclTax).minus(credited[0]!.total);
    const settled = netDue.minus(invoice.amountPaid).lte(0); // montant réglé déjà mis à jour dans la transaction
    const share = netDue.isZero() ? new D(0) : dec(alloc.amount).dividedBy(netDue);
    const lines: PostingLine[] = [];
    const odLabel = `TVA exigible — ${payment.number} / ${invoice.number}`;
    for (const [pendingAccount, p] of pending) {
      const remaining = p.initial.minus(p.transferred);
      let transfer = settled && share.isPositive() ? remaining : roundMoney(p.initial.times(share));
      // Bornes : jamais plus que le restant, jamais de reprise supérieure à ce qui a été transféré.
      if (transfer.greaterThan(remaining)) transfer = remaining;
      if (transfer.lessThan(p.transferred.negated())) transfer = p.transferred.negated();
      if (transfer.isZero()) continue;
      const collected = `44571${pendingAccount.slice(5)}`;
      lines.push({ account: pendingAccount, amount: transfer, label: odLabel });
      lines.push({ account: collected, amount: transfer.negated(), label: odLabel });
    }
    if (lines.length) {
      await postEntry(
        tx,
        company,
        { journalCode: "OD", entryDate: payment.paymentDate, pieceRef: payment.number, pieceDate: payment.paymentDate, label: odLabel, sourceKey: `vat:${payment.id}:${invoice.id}`, lines },
        now,
      );
    }
  }
  return entryId;
}

// ─── Achats ─────────────────────────────────────────────────────────────────

export async function postExpense(
  tx: Tx,
  company: Company,
  input: { expense: Expense; lines: ExpenseLine[]; supplier: ThirdParty },
  now?: Date,
) {
  const { expense, lines, supplier } = input;
  if (expense.status !== "validated") return null;
  await ensureJournal(tx, company.id, "AC");
  const franchise = company.vatRegime === "franchise_en_base";
  const label = `Facture ${expense.supplierReference ?? expense.number} — ${supplier.name}`;
  const vatAssets = lines.filter((l) => l.ledgerAccount.startsWith("2")).reduce((a, l) => a.plus(l.vatAmount), new D(0));
  const vatOther = lines.filter((l) => !l.ledgerAccount.startsWith("2")).reduce((a, l) => a.plus(l.vatAmount), new D(0));
  return postEntry(
    tx,
    company,
    {
      journalCode: "AC",
      entryDate: expense.invoiceDate,
      pieceRef: expense.number!,
      pieceDate: expense.invoiceDate,
      label,
      sourceKey: `expense:${expense.id}`,
      lines: [
        // Franchise en base : la TVA facturée par le fournisseur n'est pas récupérable, elle s'ajoute à la charge.
        ...lines.map((l) => ({ account: l.ledgerAccount, amount: dec(l.amountExclTax).plus(franchise ? l.vatAmount : 0), label: `${label} — ${l.description}` })),
        { account: "445620", amount: franchise ? new D(0) : vatAssets, label },
        { account: "445660", amount: franchise ? new D(0) : vatOther, label },
        { account: "401000", amount: dec(expense.totalInclTax).negated(), label, aux: { number: supplier.code, label: supplier.name } },
      ],
    },
    now,
  );
}

export async function postExpensePayment(
  tx: Tx,
  company: Company,
  input: { payment: ExpensePayment; expense: Expense; supplier: ThirdParty },
  now?: Date,
) {
  const { payment, expense, supplier } = input;
  const [account] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, payment.bankAccountId)).limit(1);
  const journalCode = await treasuryJournal(tx, company.id, account!);
  const amount = dec(payment.amount);
  const label = `${payment.reversesId ? "Contre-passation" : "Paiement"} ${payment.number} — ${supplier.name} (${expense.number})`;
  return postEntry(
    tx,
    company,
    {
      journalCode,
      entryDate: payment.paymentDate,
      pieceRef: payment.number,
      pieceDate: payment.paymentDate,
      label,
      sourceKey: `expense_payment:${payment.id}`,
      lines: [
        { account: "401000", amount, label, aux: { number: supplier.code, label: supplier.name } },
        { account: account!.ledgerAccount, accountLabel: account!.name, amount: amount.negated(), label },
      ],
    },
    now,
  );
}

export async function loadCompany(tx: Executor, companyId: string): Promise<Company> {
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  return company!;
}

export async function listAccounts(tx: Executor, companyId: string) {
  return tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.companyId, companyId)).orderBy(asc(ledgerAccounts.number));
}

// ─── Caisse ─────────────────────────────────────────────────────────────────

export interface CashTicketPosting {
  ticket: { id: string; number: string; businessDate: string; kind: "sale" | "refund"; training: boolean; totalInclTax: string };
  lines: { kind: "good" | "service"; vatRate: string; totalInclTax: string }[];
  payments: { method: string; amount: string }[];
  cashLedgerAccount: string;
  cashAccountName: string;
}

/** Ventilation HT par nature et TVA par taux d'un ticket (prix TTC). */
export function cashTicketBreakdown(lines: CashTicketPosting["lines"]) {
  const HUNDRED = new D(100);
  const byRate = new Map<string, { ttc: Dec; services: Dec }>();
  for (const l of lines) {
    const key = dec(l.vatRate).toFixed(2);
    const cur = byRate.get(key) ?? { ttc: new D(0), services: new D(0) };
    cur.ttc = cur.ttc.plus(l.totalInclTax);
    if (l.kind === "service") cur.services = cur.services.plus(l.totalInclTax);
    byRate.set(key, cur);
  }
  let goods = new D(0);
  let services = new D(0);
  const vat: { rate: string; amount: Dec }[] = [];
  for (const [rate, v] of byRate) {
    const ht = roundMoney(v.ttc.times(HUNDRED).dividedBy(HUNDRED.plus(rate)));
    // Part « services » plafonnée en valeur absolue (les remboursements sont négatifs).
    const rawServices = roundMoney(v.services.times(HUNDRED).dividedBy(HUNDRED.plus(rate)));
    const htServices = rawServices.abs().greaterThan(ht.abs()) ? ht : rawServices;
    services = services.plus(htServices);
    goods = goods.plus(ht.minus(htServices));
    vat.push({ rate, amount: v.ttc.minus(ht) });
  }
  return { goods, services, vat };
}

export async function postCashTicket(tx: Tx, company: Company, input: CashTicketPosting, now?: Date) {
  const { ticket } = input;
  if (ticket.training) return null; // mode école : jamais comptabilisé
  await ensureJournal(tx, company.id, "VC");
  const [bank] = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, company.id), eq(bankAccounts.kind, "bank"), eq(bankAccounts.isDefault, true)))
    .limit(1);
  const { goods, services, vat } = cashTicketBreakdown(input.lines);
  const label = `${ticket.kind === "refund" ? "Remboursement" : "Ticket"} ${ticket.number}`;
  const byAccount = new Map<string, { label?: string; amount: Dec }>();
  for (const p of input.payments) {
    const account = p.method === "cash" ? input.cashLedgerAccount : (bank?.ledgerAccount ?? "512000");
    const cur = byAccount.get(account) ?? { label: p.method === "cash" ? input.cashAccountName : bank?.name, amount: new D(0) };
    cur.amount = cur.amount.plus(p.amount);
    byAccount.set(account, cur);
  }
  return postEntry(
    tx,
    company,
    {
      journalCode: "VC",
      entryDate: ticket.businessDate,
      pieceRef: ticket.number,
      pieceDate: ticket.businessDate,
      label,
      sourceKey: `cash_ticket:${ticket.id}`,
      lines: [
        ...[...byAccount.entries()].map(([account, v]) => ({ account, accountLabel: v.label, amount: v.amount, label })),
        { account: "706000", amount: services.negated(), label },
        { account: "707000", amount: goods.negated(), label },
        ...vat.map((v) => ({ account: collectedVatAccount(v.rate), amount: v.amount.negated(), label })),
      ],
    },
    now,
  );
}

/** Écart de caisse constaté à la fermeture : manquant en charge (658), excédent en produit (758). */
export async function postCashDifference(
  tx: Tx,
  company: Company,
  input: { sessionId: string; registerCode: string; date: string; difference: string; cashLedgerAccount: string; cashAccountName: string },
  now?: Date,
) {
  const diff = dec(input.difference);
  if (diff.isZero()) return null;
  await ensureJournal(tx, company.id, "OD");
  const label = `Écart de caisse ${input.registerCode} du ${input.date.split("-").reverse().join("/")}`;
  return postEntry(
    tx,
    company,
    {
      journalCode: "OD",
      entryDate: input.date,
      pieceRef: `SESSION-${input.registerCode}-${input.date}`,
      pieceDate: input.date,
      label,
      sourceKey: `cash_difference:${input.sessionId}`,
      lines: [
        { account: input.cashLedgerAccount, accountLabel: input.cashAccountName, amount: diff, label },
        { account: diff.isNegative() ? "658000" : "758000", amount: diff.negated(), label },
      ],
    },
    now,
  );
}
