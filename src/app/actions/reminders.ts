"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import { sendReminder } from "@/server/services/reminders";

export async function sendReminderAction(invoiceId: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const { sent, reminder } = await sendReminder(await getDb(), ctx, String(invoiceId), values);
    revalidatePath("/ventes/relances");
    return { ok: true, message: sent ? `Relance envoyée à ${reminder.recipient}.` : "Relance enregistrée." };
  } catch (err) {
    return toActionError(err);
  }
}
