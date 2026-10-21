"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import { recordPayment, reversePayment } from "@/server/services/payments";

export async function recordPaymentAction(values: unknown): Promise<ActionResult<{ id: string; number: string; replayed: boolean }>> {
  try {
    const { ctx } = await requireCompanyContext();
    const { result, replayed } = await recordPayment(await getDb(), ctx, values);
    revalidatePath("/reglements");
    revalidatePath("/ventes", "layout");
    return {
      ok: true,
      data: { id: result.id, number: result.number, replayed },
      message: replayed ? `Règlement déjà enregistré (${result.number}).` : `Règlement ${result.number} enregistré.`,
    };
  } catch (err) {
    return toActionError(err);
  }
}

export async function reversePaymentAction(id: string, values: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const { ctx } = await requireCompanyContext();
    const { result } = await reversePayment(await getDb(), ctx, String(id), values);
    revalidatePath("/reglements", "layout");
    revalidatePath("/ventes", "layout");
    return { ok: true, data: { id: result.id }, message: `Contre-passation ${result.number} enregistrée.` };
  } catch (err) {
    return toActionError(err);
  }
}
