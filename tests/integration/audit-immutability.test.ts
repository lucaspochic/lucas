import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { auditEvents, documentSequences } from "@/server/db/schema";
import { appendAuditEvent, verifyAuditChain } from "@/server/services/audit";
import { allocateDocumentNumber } from "@/server/services/sequences";
import { updateCompany } from "@/server/services/companies";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
let a: Awaited<ReturnType<typeof createUserWithCompany>>;

/** Message de l'erreur PostgreSQL (Drizzle l'enveloppe dans DrizzleQueryError.cause). */
async function dbError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} | ${e.cause?.message ?? ""}`;
  }
  throw new Error("La requête aurait dû être refusée par la base.");
}

beforeAll(async () => {
  h = await createTestDb();
  a = await createUserWithCompany(h, "Gamma");
  for (let i = 0; i < 5; i++) {
    await h.db.transaction((tx) =>
      appendAuditEvent(tx, {
        companyId: a.company.id,
        actorUserId: a.user.id,
        action: "test.event",
        entityType: "test",
        entityId: String(i),
        payload: { amount: "12.50", i, nested: { z: 1, a: [true, null] } },
      }),
    );
  }
});
afterAll(async () => {
  await h.close();
});

describe("journal d'audit chaîné", () => {
  it("la chaîne est continue et vérifiable", async () => {
    const result = await verifyAuditChain(h.db, a.company.id);
    expect(result).toMatchObject({ valid: true, eventsChecked: 6 }); // création + 5
  });

  it("la base refuse la modification d'un événement", async () => {
    expect(
      await dbError(h.db.update(auditEvents).set({ action: "falsifié" }).where(eq(auditEvents.companyId, a.company.id))),
    ).toMatch(/ajout seul : opération UPDATE interdite/);
  });

  it("la base refuse la suppression et la troncature", async () => {
    expect(await dbError(h.db.delete(auditEvents).where(eq(auditEvents.companyId, a.company.id)))).toMatch(
      /opération DELETE interdite/,
    );
    expect(await dbError(h.db.execute(sql`truncate table audit_events`))).toMatch(/opération TRUNCATE interdite/);
  });

  it("une altération contournant les triggers est détectée par la vérification", async () => {
    // Simule un administrateur de base qui désactive la protection.
    await h.db.execute(sql`alter table audit_events disable trigger audit_events_append_only`);
    await h.db.execute(sql`update audit_events set payload = '{"amount":"99.99"}' where company_id = ${a.company.id} and chain_seq = 3`);
    await h.db.execute(sql`alter table audit_events enable trigger audit_events_append_only`);
    const result = await verifyAuditChain(h.db, a.company.id);
    expect(result.valid).toBe(false);
    expect(result.firstError?.chainSeq).toBe(3);
  });

  it("une suppression contournant les triggers est détectée", async () => {
    const b = await createUserWithCompany(h, "Delta");
    await updateCompany(h.db, b.ctx, {
      legalName: "Delta modifiée",
      paymentTermsDays: 30,
      invoicePrefix: "FA",
      creditNotePrefix: "AV",
      quotePrefix: "DE",
    });
    await updateCompany(h.db, b.ctx, {
      legalName: "Delta modifiée 2",
      paymentTermsDays: 30,
      invoicePrefix: "FA",
      creditNotePrefix: "AV",
      quotePrefix: "DE",
    });
    expect((await verifyAuditChain(h.db, b.company.id)).valid).toBe(true);
    await h.db.execute(sql`alter table audit_events disable trigger audit_events_append_only`);
    await h.db.execute(sql`delete from audit_events where company_id = ${b.company.id} and chain_seq = 2`);
    await h.db.execute(sql`alter table audit_events enable trigger audit_events_append_only`);
    const result = await verifyAuditChain(h.db, b.company.id);
    expect(result.valid).toBe(false);
    expect(result.firstError?.reason).toMatch(/séquence/);
  });
});

describe("numérotation des documents", () => {
  it("attribue des numéros continus par type et par exercice", async () => {
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await h.db.transaction((tx) =>
        allocateDocumentNumber(tx, { companyId: a.company.id, documentType: "invoice", fiscalYear: 2026, prefix: "FA" }),
      );
      numbers.push(r.number);
    }
    expect(numbers).toEqual(["FA-2026-00001", "FA-2026-00002", "FA-2026-00003"]);
    const other = await h.db.transaction((tx) =>
      allocateDocumentNumber(tx, { companyId: a.company.id, documentType: "credit_note", fiscalYear: 2026, prefix: "AV" }),
    );
    expect(other.number).toBe("AV-2026-00001");
  });

  it("une transaction annulée ne consomme pas de numéro (pas de trou)", async () => {
    await expect(
      h.db.transaction(async (tx) => {
        await allocateDocumentNumber(tx, { companyId: a.company.id, documentType: "invoice", fiscalYear: 2026, prefix: "FA" });
        throw new Error("échec de l'émission");
      }),
    ).rejects.toThrow("échec");
    const next = await h.db.transaction((tx) =>
      allocateDocumentNumber(tx, { companyId: a.company.id, documentType: "invoice", fiscalYear: 2026, prefix: "FA" }),
    );
    expect(next.number).toBe("FA-2026-00004");
  });

  it("les allocations concurrentes ne produisent ni doublon ni trou", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.db.transaction((tx) =>
          allocateDocumentNumber(tx, { companyId: a.company.id, documentType: "quote", fiscalYear: 2027, prefix: "DE" }),
        ),
      ),
    );
    const values = results.map((r) => r.value).sort((x, y) => x - y);
    expect(values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const [row] = await h.db
      .select()
      .from(documentSequences)
      .where(sql`${documentSequences.companyId} = ${a.company.id} and ${documentSequences.documentType} = 'quote'`);
    expect(row?.lastValue).toBe(10);
  });

  it("la base refuse de faire reculer, sauter ou supprimer un compteur", async () => {
    const where = sql`${documentSequences.companyId} = ${a.company.id} and ${documentSequences.documentType} = 'quote'`;
    expect(await dbError(h.db.update(documentSequences).set({ lastValue: 3 }).where(where))).toMatch(/avancer que d'une unité/);
    expect(await dbError(h.db.update(documentSequences).set({ lastValue: 12 }).where(where))).toMatch(/avancer que d'une unité/);
    expect(await dbError(h.db.delete(documentSequences).where(where))).toMatch(/Suppression d'un compteur/);
  });
});
