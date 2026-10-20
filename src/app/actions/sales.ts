"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import {
  convertQuoteToInvoice,
  createCreditNoteDraft,
  createDraft,
  deleteDraft,
  issueDocument,
  respondToQuote,
  updateDraft,
  type EditableType,
} from "@/server/services/sales";
import { AppError } from "@/server/errors";

export async function createSalesDraftAction(type: EditableType, values: unknown): Promise<ActionResult> {
  let id: string;
  try {
    const { ctx } = await requireCompanyContext();
    if (type !== "quote" && type !== "invoice") throw new AppError("VALIDATION", "Type invalide.");
    id = (await createDraft(await getDb(), ctx, type, values)).id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/ventes/${id}`);
}

export async function updateSalesDraftAction(id: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await updateDraft(await getDb(), ctx, String(id), values);
    revalidatePath(`/ventes/${id}`);
    return { ok: true, message: "Brouillon enregistré." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteSalesDraftAction(id: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await deleteDraft(await getDb(), ctx, String(id));
  } catch (err) {
    return toActionError(err);
  }
  redirect("/ventes");
}

export async function issueSalesDocumentAction(id: string, acceptWarnings: boolean): Promise<ActionResult<{ warnings?: string }>> {
  try {
    const { ctx } = await requireCompanyContext();
    const doc = await issueDocument(await getDb(), ctx, String(id), { acceptWarnings: acceptWarnings === true });
    revalidatePath(`/ventes/${id}`);
    revalidatePath("/ventes");
    return { ok: true, message: `Document émis sous le numéro ${doc.number}.` };
  } catch (err) {
    // Avertissements : renvoyés pour confirmation explicite par l'utilisateur.
    if (err instanceof AppError && err.code === "CONFLICT") return { ok: true, data: { warnings: err.message } };
    return toActionError(err);
  }
}

export async function respondToQuoteAction(id: string, response: "accepted" | "refused"): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    if (response !== "accepted" && response !== "refused") throw new AppError("VALIDATION", "Réponse invalide.");
    await respondToQuote(await getDb(), ctx, String(id), response);
    revalidatePath(`/ventes/${id}`);
    return { ok: true, message: response === "accepted" ? "Devis marqué comme accepté." : "Devis marqué comme refusé." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function convertQuoteAction(id: string): Promise<ActionResult> {
  let target: string;
  try {
    const { ctx } = await requireCompanyContext();
    target = (await convertQuoteToInvoice(await getDb(), ctx, String(id))).id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/ventes/${target}`);
}

export async function createCreditNoteAction(invoiceId: string): Promise<ActionResult> {
  let target: string;
  try {
    const { ctx } = await requireCompanyContext();
    target = (await createCreditNoteDraft(await getDb(), ctx, String(invoiceId))).id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/ventes/${target}`);
}
