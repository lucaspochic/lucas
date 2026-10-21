/**
 * Contrôle d'intégrité complet, utilisable en supervision (cron) :
 *  - chaînes du journal d'audit (système + chaque entreprise) ;
 *  - chaîne des règlements de chaque entreprise ;
 *  - empreinte de chaque document de vente émis ;
 *  - caisses : chaîne des tickets, chaîne et signatures des clôtures.
 * Code de sortie 2 si une altération est détectée.
 * Utilisation : npm run audit:verify
 */
import { and, eq, ne } from "drizzle-orm";
import { openDatabase } from "../src/server/db/client";
import { cashRegisters, companies, salesDocuments } from "../src/server/db/schema";
import { verifyAuditChain } from "../src/server/services/audit";
import { verifyPaymentChain } from "../src/server/services/payments";
import { verifyDocumentIntegrity } from "../src/server/services/sales";
import { verifyRegister } from "../src/server/services/cash";

async function main() {
  const handle = await openDatabase(process.env.DATABASE_URL ?? "pglite:./.data/pglite", { migrate: false });
  let failures = 0;
  const report = (entry: Record<string, unknown>) => {
    if (entry.valid === false) failures++;
    console.log(JSON.stringify(entry));
  };
  try {
    const system = await verifyAuditChain(handle.db, null);
    report({ check: "audit", chain: "système", valid: system.valid, events: system.eventsChecked, error: system.firstError });

    const list = await handle.db.select({ id: companies.id, name: companies.legalName }).from(companies);
    for (const c of list) {
      const audit = await verifyAuditChain(handle.db, c.id);
      report({ check: "audit", chain: c.name, valid: audit.valid, events: audit.eventsChecked, error: audit.firstError });

      const pay = await verifyPaymentChain(handle.db, c.id);
      report({ check: "reglements", chain: c.name, valid: pay.valid, payments: pay.checked, error: pay.firstError });

      // Contexte technique en lecture seule pour la vérification des documents.
      const ctx = { userId: "00000000-0000-0000-0000-000000000000", companyId: c.id, role: "viewer" as const };
      const docs = await handle.db
        .select({ id: salesDocuments.id, number: salesDocuments.number })
        .from(salesDocuments)
        .where(and(eq(salesDocuments.companyId, c.id), ne(salesDocuments.status, "draft")));
      const altered: string[] = [];
      for (const d of docs) {
        if (!(await verifyDocumentIntegrity(handle.db, ctx, d.id)).valid) altered.push(d.number!);
      }
      report({ check: "documents", chain: c.name, valid: altered.length === 0, documents: docs.length, altered });

      const registers = await handle.db.select({ id: cashRegisters.id, code: cashRegisters.code }).from(cashRegisters).where(eq(cashRegisters.companyId, c.id));
      for (const r of registers) {
        const cash = await verifyRegister(handle.db, c.id, r.id);
        report({ check: "caisse", chain: `${c.name} / ${r.code}`, valid: cash.valid, tickets: cash.tickets, closures: cash.closures, errors: cash.errors.slice(0, 5) });
      }
    }
  } finally {
    await handle.close();
  }
  process.exit(failures ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
