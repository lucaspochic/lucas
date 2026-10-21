import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  companies,
  expenseLines,
  expensePayments,
  expenses,
  paymentAllocations,
  payments,
  salesDocumentLines,
  salesDocuments,
  thirdParties,
} from "../db/schema";
import { postCustomerPayment, postExpense, postExpensePayment, postSalesDocument, seedChartOfAccounts } from "./accounting";

/**
 * Reprise comptable : comptabilise, dans l'ordre chronologique, les événements antérieurs
 * au module comptable. Idempotent (une écriture par événement) : peut être relancé sans
 * créer de doublon. Une transaction par événement.
 */
export async function backfillAccounting(db: Db, companyId?: string) {
  const list = companyId ? await db.select().from(companies).where(eq(companies.id, companyId)) : await db.select().from(companies);
  const report: { company: string; events: number }[] = [];
  for (const company of list) {
    await db.transaction((tx) => seedChartOfAccounts(tx, company.id));
    type Event = { at: number; run: () => Promise<unknown> };
    const events: Event[] = [];

    const docs = await db
      .select()
      .from(salesDocuments)
      .where(and(eq(salesDocuments.companyId, company.id), ne(salesDocuments.status, "draft"), ne(salesDocuments.type, "quote")))
      .orderBy(asc(salesDocuments.issuedAt));
    for (const doc of docs) {
      events.push({
        at: doc.issuedAt!.getTime(),
        run: () =>
          db.transaction(async (tx) => {
            const lines = await tx.select().from(salesDocumentLines).where(eq(salesDocumentLines.documentId, doc.id)).orderBy(asc(salesDocumentLines.position));
            const [party] = await tx.select().from(thirdParties).where(eq(thirdParties.id, doc.thirdPartyId));
            const [source] = doc.sourceDocumentId ? await tx.select().from(salesDocuments).where(eq(salesDocuments.id, doc.sourceDocumentId)) : [];
            await postSalesDocument(tx, company, { doc, lines, party: party!, sourceNumber: source?.number ?? null });
          }),
      });
    }

    const pays = await db.select().from(payments).where(eq(payments.companyId, company.id)).orderBy(asc(payments.chainSeq));
    for (const p of pays) {
      events.push({
        at: p.recordedAt.getTime(),
        run: () =>
          db.transaction(async (tx) => {
            const allocations = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, p.id));
            const [party] = await tx.select().from(thirdParties).where(eq(thirdParties.id, p.thirdPartyId));
            await postCustomerPayment(tx, company, { payment: p, allocations: allocations.map((a) => ({ documentId: a.documentId, amount: a.amount })), party: party! });
          }),
      });
    }

    const exps = await db.select().from(expenses).where(and(eq(expenses.companyId, company.id), eq(expenses.status, "validated")));
    for (const e of exps) {
      events.push({
        at: e.validatedAt!.getTime(),
        run: () =>
          db.transaction(async (tx) => {
            const lines = await tx.select().from(expenseLines).where(eq(expenseLines.expenseId, e.id)).orderBy(asc(expenseLines.position));
            const [supplier] = await tx.select().from(thirdParties).where(eq(thirdParties.id, e.thirdPartyId));
            await postExpense(tx, company, { expense: e, lines, supplier: supplier! });
          }),
      });
    }

    const expPays = await db.select().from(expensePayments).where(eq(expensePayments.companyId, company.id));
    for (const p of expPays) {
      events.push({
        at: p.recordedAt.getTime(),
        run: () =>
          db.transaction(async (tx) => {
            const [e] = await tx.select().from(expenses).where(eq(expenses.id, p.expenseId));
            const [supplier] = await tx.select().from(thirdParties).where(eq(thirdParties.id, e!.thirdPartyId));
            await postExpensePayment(tx, company, { payment: p, expense: e!, supplier: supplier! });
          }),
      });
    }

    events.sort((a, b) => a.at - b.at);
    for (const ev of events) await ev.run();
    report.push({ company: company.legalName, events: events.length });
  }
  return report;
}
