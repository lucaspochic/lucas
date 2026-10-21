import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { cashClosures, cashSessions, cashTicketLines, cashTickets, journalEntries, journalLines } from "@/server/db/schema";
import {
  closeSession,
  closeToday,
  createRegister,
  exportArchive,
  getRegister,
  getTicket,
  listClosures,
  openSession,
  recordTicket,
  refundTicket,
  verifyArchive,
  verifyRegister,
} from "@/server/services/cash";
import { checkLedger } from "@/server/services/accounting-reports";
import { createZip, readZip } from "@/server/domain/zip";
import { computeTicketTotals } from "@/server/domain/cash";
import type { CompanyContext } from "@/server/security/permissions";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;

const at = (iso: string) => ({ now: new Date(iso) });

async function failure(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} | ${e.cause?.message ?? ""}`;
  }
  throw new Error("L'opération aurait dû être refusée.");
}

const sale = (lines: { label?: string; quantity?: string; price: string; rate?: string; kind?: "good" | "service"; discount?: string }[], payments: { method: string; amount: string }[], extra: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  lines: lines.map((l) => ({
    label: l.label ?? "Article",
    kind: l.kind ?? "good",
    quantity: l.quantity ?? "1",
    unitPriceInclTax: l.price,
    vatRate: l.rate ?? "20",
    discountPercent: l.discount ?? "0",
  })),
  payments,
  ...extra,
});

async function setup(name: string) {
  const c = await createUserWithCompany(h, name);
  const register = await createRegister(h.db, c.ctx, { code: "C1", name: "Comptoir" });
  return { ...c, register };
}

async function entryLines(ctx: CompanyContext, sourceKey: string) {
  return h.db
    .select({ account: journalLines.accountNumber, debit: journalLines.debit, credit: journalLines.credit, journal: journalEntries.journalCode, date: journalEntries.entryDate })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceKey, sourceKey)))
    .orderBy(journalLines.lineNo);
}

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("calcul d'un ticket (prix TTC)", () => {
  it("ventile la TVA par taux à partir du TTC, sans écart d'arrondi", () => {
    const t = computeTicketTotals([
      { quantity: "3", unitPriceInclTax: "1.99", vatRate: "5.5" },
      { quantity: "1", unitPriceInclTax: "12.00", vatRate: "20" },
      { quantity: "2", unitPriceInclTax: "10.00", vatRate: "20", discountPercent: "10" },
    ]);
    expect(t.lineTotals).toEqual(["5.97", "12.00", "18.00"]);
    expect(t.totalInclTax).toBe("35.97");
    // 5,5 % : HT = 5,97 × 100 / 105,5 = 5,66 ; 20 % : HT = 30 / 1,2 = 25,00.
    expect(t.vat).toEqual([
      { vatRate: "20.00", inclTax: "30.00", exclTax: "25.00", vat: "5.00" },
      { vatRate: "5.50", inclTax: "5.97", exclTax: "5.66", vat: "0.31" },
    ]);
    expect(t.totalExclTax).toBe("30.66");
    expect(t.totalVat).toBe("5.31");
  });
});

describe("caisse : sessions et tickets", () => {
  it("refuse un ticket sans session ouverte, puis enregistre un ticket chaîné et comptabilisé", async () => {
    const c = await setup("Boulangerie");
    expect(await failure(recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "10" }], [{ method: "cash", amount: "10" }]), at("2026-03-02T09:00:00Z")))).toContain("Ouvrez d'abord la caisse");

    await openSession(h.db, c.ctx, c.register.id, { openingFloat: "100" }, at("2026-03-02T07:00:00Z"));
    expect(await failure(openSession(h.db, c.ctx, c.register.id, { openingFloat: "50" }))).toContain("déjà ouverte");

    const input = sale(
      [
        { label: "Baguette", quantity: "3", price: "1.20", rate: "5.5" },
        { label: "Livraison", price: "6.00", kind: "service" },
      ],
      [
        { method: "cash", amount: "5" },
        { method: "card", amount: "4.60" },
      ],
    );
    const first = await recordTicket(h.db, c.ctx, c.register.id, input, at("2026-03-02T09:00:00Z"));
    expect(first.replayed).toBe(false);
    expect(first.result).toMatchObject({ seq: 1, number: "C1-000001", kind: "sale", totalInclTax: "9.60", businessDate: "2026-03-02" });

    // Rejeu : même clé, même ticket, pas de doublon.
    const again = await recordTicket(h.db, c.ctx, c.register.id, input, at("2026-03-02T09:00:05Z"));
    expect(again).toMatchObject({ replayed: true, result: { id: first.result.id } });

    const second = await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "2.50" }], [{ method: "cash", amount: "2.50" }]), at("2026-03-02T10:00:00Z"));
    expect(second.result.seq).toBe(2);
    expect(second.result.prevHash).toBe(first.result.hash);

    // Écriture VC : 530 + 512 au débit ; 707, 706, TVA au crédit ; équilibrée.
    const lines = await entryLines(c.ctx, `cash_ticket:${first.result.id}`);
    expect(lines.every((l) => l.journal === "VC" && l.date === "2026-03-02")).toBe(true);
    const by = (acc: string) => lines.filter((l) => l.account === acc).reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0).toFixed(2);
    expect(by("530000")).toBe("5.00");
    expect(by("512000")).toBe("4.60");
    expect(by("707000")).toBe("-3.41"); // 3,60 TTC à 5,5 % → 3,41 HT
    expect(by("706000")).toBe("-5.00"); // 6,00 TTC à 20 % → 5,00 HT
    const vat = lines.filter((l) => l.account.startsWith("4457")).reduce((a, l) => a + Number(l.credit) - Number(l.debit), 0);
    expect(vat.toFixed(2)).toBe("1.19");

    const view = await getTicket(h.db, c.ctx, first.result.id);
    expect(view.lines.map((l) => l.label)).toEqual(["Baguette", "Livraison"]);
    expect(view.payments).toHaveLength(2);
  });

  it("contrôle les paiements, les taux de TVA et l'isolement entre entreprises", async () => {
    const c = await setup("Controle");
    await openSession(h.db, c.ctx, c.register.id, { openingFloat: "0" }, at("2026-03-02T07:00:00Z"));
    expect(await failure(recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "10" }], [{ method: "cash", amount: "9.99" }]), at("2026-03-02T09:00:00Z")))).toContain("doit égaler");
    expect(await failure(recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "10", rate: "7" }], [{ method: "cash", amount: "10" }]), at("2026-03-02T09:00:00Z")))).toContain("non paramétré");
    expect(await failure(createRegister(h.db, c.ctx, { code: "C1", name: "Doublon" }))).toContain("existe déjà");

    const other = await createUserWithCompany(h, "Autre");
    expect(await failure(getRegister(h.db, other.ctx, c.register.id))).toContain("introuvable");
    expect(await failure(recordTicket(h.db, other.ctx, c.register.id, sale([{ price: "1" }], [{ method: "cash", amount: "1" }])))).toContain("introuvable");

    const cashier: CompanyContext = { ...c.ctx, role: "cashier" };
    expect(await failure(closeToday(h.db, cashier, c.register.id))).toContain("droits nécessaires");
  });

  it("mode école : ticket chaîné mais ni comptabilisé ni compté dans les totaux", async () => {
    const c = await setup("Ecole");
    await openSession(h.db, c.ctx, c.register.id, { openingFloat: "0" }, at("2026-03-02T07:00:00Z"));
    const t = await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "50" }], [{ method: "cash", amount: "50" }], { training: true }), at("2026-03-02T09:00:00Z"));
    expect(t.result.training).toBe(true);
    expect(await entryLines(c.ctx, `cash_ticket:${t.result.id}`)).toHaveLength(0);
    const real = await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "8" }], [{ method: "cash", amount: "8" }]), at("2026-03-02T09:30:00Z"));
    expect(real.result.prevHash).toBe(t.result.hash);

    const closed = await closeSession(h.db, c.ctx, c.register.id, { countedCash: "8" }, at("2026-03-02T18:00:00Z"));
    expect(closed).toMatchObject({ expectedCash: "8.00", difference: "0.00" });
    const [day] = await closeToday(h.db, c.ctx, c.register.id, at("2026-03-02T18:05:00Z"));
    expect(day).toMatchObject({ kind: "day", ticketCount: 1, grandTotal: "8.00", perpetualTotal: "8.00" });
    expect((await getRegister(h.db, c.ctx, c.register.id)).perpetualTotal).toBe("8.00");
  });

  it("fermeture de session : écart de caisse constaté et comptabilisé (658/758)", async () => {
    const c = await setup("Ecart");
    await openSession(h.db, c.ctx, c.register.id, { openingFloat: "150" }, at("2026-03-02T07:00:00Z"));
    await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "20" }], [{ method: "cash", amount: "20" }]), at("2026-03-02T09:00:00Z"));
    await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "30" }], [{ method: "card", amount: "30" }]), at("2026-03-02T09:10:00Z"));
    const closed = await closeSession(h.db, c.ctx, c.register.id, { countedCash: "168.50", note: "Erreur de rendu" }, at("2026-03-02T18:00:00Z"));
    expect(closed).toMatchObject({ expectedCash: "170.00", countedCash: "168.50", difference: "-1.50" });
    const lines = await entryLines(c.ctx, `cash_difference:${closed.id}`);
    expect(lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ["530000", "0.00", "1.50"],
      ["658000", "1.50", "0.00"],
    ]);
    // Session fermée : immuable.
    expect(await failure(h.db.update(cashSessions).set({ countedCash: "170.00" }).where(eq(cashSessions.id, closed.id)))).toMatch(/immuable|interdit|clôtur/i);
    expect(await failure(closeSession(h.db, c.ctx, c.register.id, { countedCash: "0" }))).toContain("Aucune session ouverte");
  });
});

describe("caisse : concurrence", () => {
  it("tickets simultanés : numérotation continue, chaîne intacte, clôture automatique unique", async () => {
    const c = await setup("Concurrence");
    await openSession(h.db, c.ctx, c.register.id, { openingFloat: "0" }, at("2026-03-02T07:00:00Z"));
    await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "1" }], [{ method: "cash", amount: "1" }]), at("2026-03-02T09:00:00Z"));
    // Lendemain : chaque ticket déclenche la clôture du 2 mars ; une seule doit être créée.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => recordTicket(h.db, c.ctx, c.register.id, sale([{ price: String(i + 1) }], [{ method: "cash", amount: String(i + 1) }]), at("2026-03-03T09:00:00Z"))),
    );
    expect(results.map((r) => r.result.seq).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await listClosures(h.db, c.ctx, c.register.id)).map((x) => x.periodStart)).toEqual(["2026-03-02"]);
    expect(await verifyRegister(h.db, c.ctx.companyId, c.register.id)).toMatchObject({ valid: true, tickets: 9, closures: 1 });
  });
});

describe("caisse : remboursements", () => {
  it("remboursement partiel puis solde, lié au ticket d'origine, jamais au-delà du vendu", async () => {
    const c = await setup("Rembourse");
    await openSession(h.db, c.ctx, c.register.id, { openingFloat: "0" }, at("2026-03-02T07:00:00Z"));
    const { result: original } = await recordTicket(
      h.db,
      c.ctx,
      c.register.id,
      sale([{ label: "Chemise", quantity: "3", price: "9.99", discount: "33.33" }, { label: "Sac", price: "2" }], [{ method: "card", amount: "21.98" }]),
      at("2026-03-02T09:00:00Z"),
    );
    // 3 × 9,99 × 0,6667 = 19,98 (arrondi) ; + 2,00.
    expect(original.totalInclTax).toBe("21.98");
    const total = original.totalInclTax;

    expect(await failure(refundTicket(h.db, c.ctx, original.id, { idempotencyKey: randomUUID(), reason: "x", payments: [{ method: "card", amount: total }] }))).toContain("Motif");
    const partial = await refundTicket(
      h.db,
      c.ctx,
      original.id,
      { idempotencyKey: randomUUID(), reason: "Taille", lines: [{ position: 1, quantity: "1" }], payments: [{ method: "cash", amount: "6.66" }] },
      at("2026-03-02T10:00:00Z"),
    );
    expect(partial.result).toMatchObject({ kind: "refund", refundOfId: original.id, totalInclTax: "-6.66", seq: 2 });
    expect(
      await failure(refundTicket(h.db, c.ctx, original.id, { idempotencyKey: randomUUID(), reason: "Encore", lines: [{ position: 1, quantity: "3" }], payments: [{ method: "cash", amount: "19.98" }] }, at("2026-03-02T10:05:00Z"))),
    ).toContain("au plus restent");
    expect(await failure(refundTicket(h.db, c.ctx, partial.result.id, { idempotencyKey: randomUUID(), reason: "Refus", payments: [{ method: "cash", amount: "1" }] }))).toContain("Seul un ticket de vente");

    // Solde : le cumul remboursé égale exactement l'encaissé.
    const rest = await refundTicket(h.db, c.ctx, original.id, { idempotencyKey: randomUUID(), reason: "Retour complet", payments: [{ method: "card", amount: (Number(total) - 6.66).toFixed(2) }] }, at("2026-03-02T10:10:00Z"));
    expect((Number(rest.result.totalInclTax) + Number(partial.result.totalInclTax)).toFixed(2)).toBe((-Number(total)).toFixed(2));
    expect(await failure(refundTicket(h.db, c.ctx, original.id, { idempotencyKey: randomUUID(), reason: "Encore", payments: [{ method: "card", amount: "1" }] }, at("2026-03-02T10:15:00Z")))).toContain("entièrement remboursé");

    const lines = await entryLines(c.ctx, `cash_ticket:${partial.result.id}`);
    expect(lines.find((l) => l.account === "530000")).toMatchObject({ credit: "6.66" });
    // Marchandise remboursée : extourne en 707, jamais en 706.
    expect(lines.map((l) => l.account)).not.toContain("706000");
    expect(lines.find((l) => l.account === "707000")).toMatchObject({ debit: "5.55" });
    const view = await getTicket(h.db, c.ctx, original.id);
    expect(view.refunds).toHaveLength(2);
    expect(await checkLedger(h.db, c.ctx, 2026)).toMatchObject({ balanced: true, continuous: true });
  });
});

describe("caisse : clôtures et inaltérabilité", () => {
  it("clôtures journalières automatiques, mensuelles et annuelles ; totaux perpétuels ; signatures", async () => {
    const c = await setup("Clotures");
    await openSession(h.db, c.ctx, c.register.id, { openingFloat: "0" }, at("2025-12-30T07:00:00Z"));
    await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "100" }], [{ method: "cash", amount: "100" }]), at("2025-12-30T10:00:00Z"));
    const { result: t2 } = await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "11", rate: "5.5" }], [{ method: "card", amount: "11" }]), at("2025-12-31T10:00:00Z"));
    // Le ticket du 31 a clôturé automatiquement le 30.
    const auto = await listClosures(h.db, c.ctx, c.register.id, "day");
    expect(auto.map((d) => d.periodStart)).toEqual(["2025-12-30"]);

    await refundTicket(h.db, c.ctx, t2.id, { idempotencyKey: randomUUID(), reason: "Erreur", payments: [{ method: "card", amount: "11" }] }, at("2026-01-02T10:00:00Z"));
    // Le 2 janvier : clôture du 31, du mois de décembre et de l'exercice 2025.
    const all = await listClosures(h.db, c.ctx, c.register.id);
    const summary = all.map((x) => [x.seq, x.kind, x.periodStart, x.grandTotal, x.perpetualTotal, x.perpetualAbsoluteTotal]).reverse();
    expect(summary).toEqual([
      [1, "day", "2025-12-30", "100.00", "100.00", "100.00"],
      [2, "day", "2025-12-31", "11.00", "111.00", "111.00"],
      [3, "month", "2025-12-01", "111.00", "111.00", "111.00"],
      [4, "year", "2025-01-01", "111.00", "111.00", "111.00"],
    ]);
    const month = all.find((x) => x.kind === "month")!;
    expect(month.vatBreakdown).toEqual({ "20.00:ht": "83.33", "20.00:tva": "16.67", "5.50:ht": "10.43", "5.50:tva": "0.57" });
    expect(month.paymentBreakdown).toEqual({ card: "11.00", cash: "100.00" });

    // Une journée clôturée n'accepte plus de ticket ; le jour suivant si.
    await closeSession(h.db, c.ctx, c.register.id, { countedCash: "100" }, at("2026-01-02T18:00:00Z"));
    const today = await closeToday(h.db, c.ctx, c.register.id, at("2026-01-02T18:01:00Z"));
    expect(today.map((x) => [x.kind, x.grandTotal, x.perpetualTotal, x.perpetualAbsoluteTotal])).toEqual([["day", "-11.00", "100.00", "122.00"]]);
    await openSession(h.db, c.ctx, c.register.id, { openingFloat: "0" }, at("2026-01-02T18:30:00Z"));
    expect(await failure(recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "1" }], [{ method: "cash", amount: "1" }]), at("2026-01-02T19:00:00Z")))).toContain("journée est clôturée");
    await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "1" }], [{ method: "cash", amount: "1" }]), at("2026-01-03T09:00:00Z"));

    const check = await verifyRegister(h.db, c.ctx.companyId, c.register.id);
    expect(check).toMatchObject({ valid: true, tickets: 4, closures: 5, errors: [] });
  });

  it("ajout seul : modification et suppression refusées par la base ; altération détectée", async () => {
    const c = await setup("Inalterable");
    await openSession(h.db, c.ctx, c.register.id, { openingFloat: "0" }, at("2026-03-02T07:00:00Z"));
    const { result } = await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "10" }], [{ method: "cash", amount: "10" }]), at("2026-03-02T09:00:00Z"));
    await recordTicket(h.db, c.ctx, c.register.id, sale([{ price: "5" }], [{ method: "cash", amount: "5" }]), at("2026-03-02T09:30:00Z"));
    await closeSession(h.db, c.ctx, c.register.id, { countedCash: "15" }, at("2026-03-02T18:00:00Z"));
    await closeToday(h.db, c.ctx, c.register.id, at("2026-03-02T18:05:00Z"));

    expect(await failure(h.db.update(cashTickets).set({ totalInclTax: "1.00" }).where(eq(cashTickets.id, result.id)))).toContain("ajout seul");
    expect(await failure(h.db.delete(cashTickets).where(eq(cashTickets.id, result.id)))).toContain("ajout seul");
    expect(await failure(h.db.update(cashTicketLines).set({ label: "Autre" }).where(eq(cashTicketLines.ticketId, result.id)))).toContain("ajout seul");
    expect(await failure(h.db.update(cashClosures).set({ grandTotal: "0" }).where(eq(cashClosures.registerId, c.register.id)))).toContain("ajout seul");
    expect(await failure(h.db.execute(sql`truncate cash_tickets cascade`))).toMatch(/ajout seul|truncate/i);

    // Contournement par un administrateur de la base (déclencheurs désactivés) : détecté.
    await h.db.execute(sql`alter table cash_ticket_lines disable trigger user`);
    await h.db.update(cashTicketLines).set({ label: "Article modifié" }).where(eq(cashTicketLines.ticketId, result.id));
    await h.db.execute(sql`alter table cash_ticket_lines enable trigger user`);
    await h.db.execute(sql`alter table cash_closures disable trigger user`);
    await h.db.update(cashClosures).set({ grandTotal: "0.00" }).where(eq(cashClosures.registerId, c.register.id));
    await h.db.execute(sql`alter table cash_closures enable trigger user`);
    const check = await verifyRegister(h.db, c.ctx.companyId, c.register.id);
    expect(check.valid).toBe(false);
    expect(check.errors).toEqual(expect.arrayContaining([`Ticket ${result.number} : contenu modifié après enregistrement.`, "Clôture day 2026-03-02 : contenu modifié."]));
  });
});

describe("caisse : archives", () => {
  it("archive ZIP signée, vérifiable ; toute altération est détectée ; journées non clôturées refusées", async () => {
    const c = await setup("Archive");
    await openSession(h.db, c.ctx, c.register.id, { openingFloat: "20" }, at("2026-04-01T07:00:00Z"));
    await recordTicket(h.db, c.ctx, c.register.id, sale([{ label: "Café; « serré »", price: "1.80", rate: "10" }], [{ method: "cash", amount: "1.80" }]), at("2026-04-01T08:00:00Z"));
    expect(await failure(exportArchive(h.db, c.ctx, c.register.id, "2026-04-01", "2026-04-30"))).toContain("non clôturée");
    await closeSession(h.db, c.ctx, c.register.id, { countedCash: "21.80" }, at("2026-04-01T18:00:00Z"));
    await closeToday(h.db, c.ctx, c.register.id, at("2026-04-01T18:05:00Z"));

    const archive = await exportArchive(h.db, c.ctx, c.register.id, "2026-04-01", "2026-04-30");
    expect(archive.fileName).toBe("archive-caisse-C1-2026-04-01-2026-04-30.zip");
    const names = readZip(archive.zip).map((e) => e.name);
    expect(names).toEqual(["tickets.csv", "lignes.csv", "paiements.csv", "clotures.csv", "sessions.csv", "LISEZ-MOI.txt", "manifeste.json", "manifeste.sig", "cle-publique.pem"]);
    expect(verifyArchive(archive.zip)).toEqual({ valid: true, errors: [] });
    const lignes = Buffer.from(readZip(archive.zip).find((e) => e.name === "lignes.csv")!.data).toString("utf8");
    expect(lignes).toContain("Café; « serré »");

    const tampered = createZip(readZip(archive.zip).map((e) => (e.name === "tickets.csv" ? { name: e.name, data: Buffer.from(Buffer.from(e.data).toString("utf8").replace("1.80", "0.80")) } : e)));
    expect(verifyArchive(tampered)).toEqual({ valid: false, errors: ["Fichier modifié : tickets.csv."] });
    const resigned = createZip(readZip(archive.zip).map((e) => (e.name === "manifeste.json" ? { name: e.name, data: Buffer.from(Buffer.from(e.data).toString("utf8").replace('"tickets": 1', '"tickets": 2')) } : e)));
    expect(verifyArchive(resigned).errors).toContain("Signature du manifeste invalide.");

    const [count] = await h.db.select({ n: sql<number>`count(*)::int` }).from(sql`cash_archives`).where(sql`register_id = ${c.register.id}`);
    expect(count!.n).toBe(1);
  });
});
