import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/server/db/client";
import { attachments } from "@/server/db/schema";
import { createThirdParty } from "@/server/services/third-parties";
import { createExpense, validateExpense } from "@/server/services/expenses";
import { addAttachment, detectFileType, listAttachments, readAttachment, removeAttachment, sanitizeFileName } from "@/server/services/attachments";
import type { CompanyContext } from "@/server/security/permissions";
import { createTestDb, createUserWithCompany } from "../helpers/db";

let h: DbHandle;
const dir = mkdtempSync(path.join(tmpdir(), "pj-test-"));
process.env.ATTACHMENTS_DIR = dir;

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-fictif")]);

async function failure(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} | ${e.cause?.message ?? ""}`;
  }
  throw new Error("L'opération aurait dû être refusée.");
}

async function setup(name: string) {
  const c = await createUserWithCompany(h, name);
  const supplier = await createThirdParty(h.db, c.ctx, { partyType: "business", name: "Fournisseur SA", isCustomer: false, isSupplier: true });
  const expense = await createExpense(h.db, c.ctx, { thirdPartyId: supplier.id, invoiceDate: "2026-10-01", lines: [{ category: "loyer", description: "Loyer", amountExclTax: "500", vatRate: "20" }] });
  return { ...c, supplier, expense };
}

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("pièces jointes", () => {
  it("type reconnu par la signature binaire ; nom assaini", () => {
    expect(detectFileType(PDF)).toEqual({ mime: "application/pdf", ext: "pdf" });
    expect(detectFileType(PNG)).toEqual({ mime: "image/png", ext: "png" });
    expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(detectFileType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toEqual({ mime: "image/webp", ext: "webp" });
    expect(detectFileType(Buffer.from("MZ\x90\0"))).toBeNull(); // exécutable renommé
    expect(detectFileType(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    expect(sanitizeFileName("C:\\Users\\x\\facture <mars>.exe", "pdf")).toBe("facture mars.pdf");
    expect(sanitizeFileName("../../etc/passwd", "png")).toBe("passwd.png");
    expect(sanitizeFileName("", "pdf")).toBe("piece-jointe.pdf");
  });

  it("ajout, lecture vérifiée, retrait d'un brouillon ; justificatif d'une dépense validée conservé", async () => {
    const c = await setup("PJ");
    expect(await failure(addAttachment(h.db, c.ctx, { entityType: "expense", entityId: c.expense.id, fileName: "virus.pdf", data: Buffer.from("MZ\x90\0") }))).toContain("Format non accepté");
    expect(await failure(addAttachment(h.db, c.ctx, { entityType: "expense", entityId: c.expense.id, fileName: "gros.pdf", data: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]) }))).toContain("10 Mo");

    const a = await addAttachment(h.db, c.ctx, { entityType: "expense", entityId: c.expense.id, fileName: "facture.PDF", data: PDF });
    expect(a).toMatchObject({ fileName: "facture.pdf", mimeType: "application/pdf", size: PDF.length });
    const read = await readAttachment(h.db, c.ctx, a.id);
    expect(read.data.equals(PDF)).toBe(true);

    const b = await addAttachment(h.db, c.ctx, { entityType: "expense", entityId: c.expense.id, fileName: "photo.png", data: PNG });
    await removeAttachment(h.db, c.ctx, b.id);
    expect((await listAttachments(h.db, c.ctx, "expense", c.expense.id)).rows.map((r) => r.fileName)).toEqual(["facture.pdf"]);

    await validateExpense(h.db, c.ctx, c.expense.id, { now: new Date("2026-10-02T10:00:00Z") });
    expect((await listAttachments(h.db, c.ctx, "expense", c.expense.id)).locked).toBe(true);
    expect(await failure(removeAttachment(h.db, c.ctx, a.id))).toContain("opération validée");
    // Ajout encore possible après validation (justificatif complémentaire).
    await addAttachment(h.db, c.ctx, { entityType: "expense", entityId: c.expense.id, fileName: "complément.png", data: PNG });

    // Base : ni suppression, ni modification.
    expect(await failure(h.db.delete(attachments).where(eq(attachments.id, a.id)))).toContain("suppression interdite");
    expect(await failure(h.db.update(attachments).set({ fileName: "autre.pdf" }).where(eq(attachments.id, a.id)))).toContain("seul le retrait");

    // Fichier altéré sur le disque : détecté à la lecture.
    writeFileSync(path.join(dir, c.ctx.companyId, a.sha256.slice(0, 2), a.sha256), Buffer.from("%PDF-falsifié"));
    expect(await failure(readAttachment(h.db, c.ctx, a.id))).toContain("altéré");
  });

  it("isolement entre entreprises et droits par rôle", async () => {
    const c = await setup("PJIso");
    const a = await addAttachment(h.db, c.ctx, { entityType: "third_party", entityId: c.supplier.id, fileName: "kbis.pdf", data: PDF });
    const other = await createUserWithCompany(h, "PJAutre");
    expect(await failure(readAttachment(h.db, other.ctx, a.id))).toContain("introuvable");
    expect(await failure(addAttachment(h.db, other.ctx, { entityType: "expense", entityId: c.expense.id, fileName: "x.pdf", data: PDF }))).toContain("introuvable");
    const cashier: CompanyContext = { ...c.ctx, role: "cashier" };
    expect(await failure(addAttachment(h.db, cashier, { entityType: "expense", entityId: c.expense.id, fileName: "x.pdf", data: PDF }))).toContain("droits");
    const viewer: CompanyContext = { ...c.ctx, role: "viewer" };
    expect((await readAttachment(h.db, viewer, a.id)).row.fileName).toBe("kbis.pdf");
    expect(await failure(removeAttachment(h.db, viewer, a.id))).toContain("droits");
  });
});
