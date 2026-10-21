import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { paymentReminders } from "@/server/db/schema";
import { listVatRates, updateCompany } from "@/server/services/companies";
import { createThirdParty } from "@/server/services/third-parties";
import { createDraft, issueDocument } from "@/server/services/sales";
import { recordPayment } from "@/server/services/payments";
import { overdueInvoices, reminderPreview, remindersOf, sendReminder } from "@/server/services/reminders";
import { buildMime } from "@/server/email/transport";
import { reminderLetter } from "@/server/domain/reminders";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
const outbox = mkdtempSync(path.join(tmpdir(), "outbox-test-"));
process.env.EMAIL_OUTBOX_DIR = outbox;
const TODAY = { now: new Date("2026-10-21T10:00:00Z") };

async function failure(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} | ${e.cause?.message ?? ""}`;
  }
  throw new Error("L'opération aurait dû être refusée.");
}

async function setup() {
  const c = await createUserWithCompany(h, "Relances");
  await updateCompany(h.db, c.ctx, {
    legalName: "Relances SAS",
    siren: "732829320",
    vatNumber: "FR44732829320",
    addressLine1: "1 rue",
    postalCode: "69001",
    city: "Lyon",
    iban: "FR7630006000011234567890189",
    paymentTermsDays: 30,
    latePenaltyText: "Pénalités de retard : trois fois le taux d'intérêt légal.",
    invoicePrefix: "FA",
    creditNotePrefix: "AV",
    quotePrefix: "DE",
  });
  const r20 = (await listVatRates(h.db, c.ctx)).find((r) => r.rate === "20.00")!.id;
  const pro = await createThirdParty(h.db, c.ctx, { partyType: "business", name: "Pro SARL", siren: "552100554", vatNumber: "FR96552100554", email: "compta@pro.example", billingLine1: "2 rue", billingPostalCode: "75001", billingCity: "Paris" });
  const perso = await createThirdParty(h.db, c.ctx, { partyType: "individual", name: "Jean Dupont", billingLine1: "3 rue", billingCity: "Lyon" });
  const invoice = async (partyId: string, day: string, ht = "100") =>
    issueDocument(
      h.db,
      c.ctx,
      (await createDraft(h.db, c.ctx, "invoice", { thirdPartyId: partyId, lines: [{ description: "Prestation", kind: "service", quantity: "1", unit: "forfait", unitPriceExclTax: ht, vatRateId: r20 }] })).id,
      { now: new Date(`${day}T10:00:00Z`) },
    );
  return { ...c, pro, perso, invoice };
}

beforeAll(async () => {
  h = await createTestDb();
});
afterEach(() => {
  delete process.env.EMAIL_TRANSPORT;
});
afterAll(async () => {
  await h.close();
  rmSync(outbox, { recursive: true, force: true });
});

describe("relances", () => {
  it("liste des factures échues, lettres par niveau, envoi par e-mail avec la facture en PDF, historique", async () => {
    const c = await setup();
    const late = await c.invoice(c.pro.id, "2026-09-01"); // échue le 01/10
    await c.invoice(c.pro.id, "2026-10-15"); // pas encore échue
    const paid = await c.invoice(c.perso.id, "2026-09-02");
    await recordPayment(h.db, c.ctx, { idempotencyKey: randomUUID(), kind: "receipt", thirdPartyId: c.perso.id, paymentDate: "2026-10-05", method: "transfer", amount: "120", allocations: [{ documentId: paid.id, amount: "120" }] }, TODAY);
    const latePerso = await c.invoice(c.perso.id, "2026-09-10");

    const list = await overdueInvoices(h.db, c.ctx, TODAY.now);
    expect(list.map((l) => [l.number, l.daysLate, l.remaining, l.nextLevel])).toEqual([
      [late.number, 20, "120.00", 1],
      [latePerso.number, 11, "120.00", 1],
    ]);

    const pro1 = (await reminderPreview(h.db, c.ctx, late.id, 1, TODAY.now)).letter;
    expect(pro1.subject).toBe(`Relance amiable — facture ${late.number} (120,00 €)`);
    expect(pro1.body).toContain("arrivée à échéance le 01/10/2026");
    expect(pro1.body).toContain("40 €");
    expect(pro1.body).toContain("IBAN FR7630006000011234567890189");
    const perso3 = (await reminderPreview(h.db, c.ctx, latePerso.id, 3, TODAY.now)).letter;
    expect(perso3.title).toBe("Mise en demeure de payer");
    expect(perso3.body).not.toContain("40 €"); // particulier : pas d'indemnité forfaitaire
    const preview = await reminderPreview(h.db, c.ctx, late.id, 1, TODAY.now);
    const once = reminderLetter({ level: 1, seller: { ...preview.seller, latePenaltyText: "Pénalités : 3 fois le taux légal ; indemnité forfaitaire de 40 euros." }, customer: preview.customer, invoice: { number: "FA-1", issueDate: "2026-09-01", dueDate: "2026-10-01", remaining: "10" }, today: "2026-10-21" }).body;
    expect(once.match(/40 (€|euros)/g)).toHaveLength(1); // pas de redite

    // E-mail : déposé dans la boîte d'envoi, facture jointe.
    const sent = await sendReminder(h.db, c.ctx, late.id, { level: 1, channel: "email" }, TODAY);
    expect(sent.sent).toBe(true);
    expect(sent.reminder).toMatchObject({ level: 1, channel: "email", recipient: "compta@pro.example", amountDue: "120.00" });
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const eml = readFileSync(path.join(outbox, files[0]!), "utf8");
    expect(eml).toContain("To: compta@pro.example");
    expect(eml).toContain(`Subject: =?UTF-8?B?${Buffer.from(pro1.subject).toString("base64")}?=`);
    expect(eml).toContain(`filename="${late.number}.pdf"`);
    expect(eml).toContain("JVBERi0"); // « %PDF- » en base64

    // Courrier : enregistré sans envoi ; niveau suivant proposé.
    expect((await sendReminder(h.db, c.ctx, late.id, { level: 2, channel: "letter" }, TODAY)).sent).toBe(false);
    expect((await overdueInvoices(h.db, c.ctx, TODAY.now))[0]).toMatchObject({ reminderCount: 2, nextLevel: 3 });
    expect((await remindersOf(h.db, c.ctx, late.id)).map((r) => r.level)).toEqual([2, 1]);

    // Refus : facture réglée, non échue, client sans e-mail, envoi non configuré.
    expect(await failure(sendReminder(h.db, c.ctx, paid.id, { level: 1, channel: "letter" }, TODAY))).toContain("réglée");
    expect(await failure(sendReminder(h.db, c.ctx, latePerso.id, { level: 1, channel: "email" }, TODAY))).toContain("Aucune adresse e-mail");
    process.env.EMAIL_TRANSPORT = "none";
    expect(await failure(sendReminder(h.db, c.ctx, late.id, { level: 3, channel: "email" }, TODAY))).toContain("pas configuré");
    expect(await remindersOf(h.db, c.ctx, late.id)).toHaveLength(2);

    // Historique en ajout seul.
    expect(await failure(h.db.update(paymentReminders).set({ level: 1 }).where(eq(paymentReminders.id, sent.reminder.id)))).toContain("ajout seul");
  });

  it("message MIME : en-têtes encodés, adresses contrôlées", () => {
    const mime = buildMime({ to: "a@b.fr", subject: "Été — relance", text: "Bonjour" }, "x@y.fr", "<1@test>", new Date("2026-10-21T10:00:00Z"));
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Été — relance").toString("base64")}?=`);
    expect(mime).toContain("Date: Wed, 21 Oct 2026 10:00:00 GMT");
    expect(() => buildMime({ to: "a@b.fr\r\nBcc: z@z.fr", subject: "x", text: "y" }, "x@y.fr", "<2@test>")).toThrow("invalide");
    expect(buildMime({ to: "a@b.fr", subject: "Ligne 1\r\nBcc: z@z.fr", text: "y" }, "x@y.fr", "<3@test>")).not.toMatch(/\r\nBcc:/);
  });
});
