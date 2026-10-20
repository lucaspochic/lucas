import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { documentSequences } from "../db/schema";
import { formatDocumentNumber, type DocumentType } from "../domain/numbering";

/**
 * Attribution d'un numéro de document : continue, sans trou ni doublon.
 *
 * Doit être appelée DANS la transaction qui émet le document. Le compteur est créé
 * au besoin puis verrouillé (SELECT … FOR UPDATE) : deux émissions concurrentes sont
 * sérialisées ; si la transaction échoue, l'incrément est annulé avec elle (pas de trou,
 * contrairement à une SEQUENCE PostgreSQL). L'unicité du numéro est en outre garantie
 * par une contrainte UNIQUE sur la table du document.
 */
export async function allocateDocumentNumber(
  tx: Tx,
  params: { companyId: string; documentType: DocumentType; fiscalYear: number; prefix: string },
): Promise<{ value: number; number: string }> {
  await tx
    .insert(documentSequences)
    .values({ companyId: params.companyId, documentType: params.documentType, fiscalYear: params.fiscalYear, lastValue: 0 })
    .onConflictDoNothing();

  const where = and(
    eq(documentSequences.companyId, params.companyId),
    eq(documentSequences.documentType, params.documentType),
    eq(documentSequences.fiscalYear, params.fiscalYear),
  );
  const [current] = await tx.select({ lastValue: documentSequences.lastValue }).from(documentSequences).where(where).for("update");
  const value = (current?.lastValue ?? 0) + 1;
  await tx.update(documentSequences).set({ lastValue: value, updatedAt: sql`now()` }).where(where);
  return { value, number: formatDocumentNumber(params.prefix, params.fiscalYear, value) };
}
