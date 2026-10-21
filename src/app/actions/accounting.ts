"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import { autoLetter, closeFiscalYear, letterLines, postManualEntry, unletter } from "@/server/services/accounting-closing";
import { formatEuro } from "@/server/domain/money";

export async function letterLinesAction(lineIds: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const group = await letterLines(await getDb(), ctx, lineIds);
    revalidatePath("/comptabilite");
    return { ok: true, message: `Lignes lettrées (${group.code}).` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function unletterAction(letteringId: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await unletter(await getDb(), ctx, String(letteringId));
    revalidatePath("/comptabilite");
    return { ok: true, message: "Lettrage annulé." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function autoLetterAction(): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const { created } = await autoLetter(await getDb(), ctx);
    revalidatePath("/comptabilite");
    return { ok: true, message: created ? `${created} lettrage(s) créé(s).` : "Aucun nouveau lettrage possible." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function closeFiscalYearAction(fiscalYear: number): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const closure = await closeFiscalYear(await getDb(), ctx, Number(fiscalYear));
    revalidatePath("/comptabilite");
    const result = Number(closure.result) >= 0 ? `bénéfice de ${formatEuro(closure.result)}` : `perte de ${formatEuro(closure.result.replace("-", ""))}`;
    return { ok: true, message: `Exercice ${closure.fiscalYear} clôturé : ${result}. À-nouveaux enregistrés.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function postManualEntryAction(values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const { replayed } = await postManualEntry(await getDb(), ctx, values);
    revalidatePath("/comptabilite");
    return { ok: true, message: replayed ? "Écriture déjà enregistrée." : "Écriture enregistrée." };
  } catch (err) {
    return toActionError(err);
  }
}
