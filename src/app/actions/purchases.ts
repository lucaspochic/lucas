"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import {
  createExpense,
  deleteExpenseDraft,
  payExpense,
  reverseExpensePayment,
  updateExpense,
  validateExpense,
} from "@/server/services/expenses";

export async function createExpenseAction(values: unknown): Promise<ActionResult> {
  let id: string;
  try {
    const { ctx } = await requireCompanyContext();
    id = (await createExpense(await getDb(), ctx, values)).id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/depenses/${id}`);
}

export async function updateExpenseAction(id: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await updateExpense(await getDb(), ctx, String(id), values);
    revalidatePath(`/depenses/${id}`);
    return { ok: true, message: "Brouillon enregistré." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteExpenseAction(id: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await deleteExpenseDraft(await getDb(), ctx, String(id));
  } catch (err) {
    return toActionError(err);
  }
  redirect("/depenses");
}

export async function validateExpenseAction(id: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const e = await validateExpense(await getDb(), ctx, String(id));
    revalidatePath("/depenses", "layout");
    return { ok: true, message: `Dépense validée sous le numéro ${e.number}.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function payExpenseAction(id: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const { result, replayed } = await payExpense(await getDb(), ctx, String(id), values);
    revalidatePath("/depenses", "layout");
    revalidatePath("/tresorerie", "layout");
    return { ok: true, message: replayed ? `Paiement déjà enregistré (${result.number}).` : `Paiement ${result.number} enregistré.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function reverseExpensePaymentAction(paymentId: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const { result } = await reverseExpensePayment(await getDb(), ctx, String(paymentId), values);
    revalidatePath("/depenses", "layout");
    revalidatePath("/tresorerie", "layout");
    return { ok: true, message: `Contre-passation ${result.number} enregistrée.` };
  } catch (err) {
    return toActionError(err);
  }
}
