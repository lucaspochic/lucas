"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import {
  createBankAccount,
  importBankStatement,
  reconcile,
  setDefaultBankAccount,
  unreconcile,
  type StatementImportReport,
} from "@/server/services/treasury";
import { CSV_MAX_BYTES } from "@/server/domain/csv";
import { AppError } from "@/server/errors";

export async function createBankAccountAction(values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const account = await createBankAccount(await getDb(), ctx, values);
    revalidatePath("/tresorerie");
    return { ok: true, message: `Compte « ${account.name} » créé.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setDefaultBankAccountAction(id: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await setDefaultBankAccount(await getDb(), ctx, String(id));
    revalidatePath("/tresorerie");
    return { ok: true, message: "Compte par défaut modifié." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function importStatementAction(accountId: string, content: string): Promise<ActionResult<StatementImportReport>> {
  try {
    const { ctx } = await requireCompanyContext();
    if (typeof content !== "string" || content.length > CSV_MAX_BYTES) throw new AppError("VALIDATION", "Fichier trop volumineux (2 Mo au maximum).");
    const report = await importBankStatement(await getDb(), ctx, String(accountId), content);
    revalidatePath(`/tresorerie/${accountId}`);
    return {
      ok: true,
      data: {
        ...report,
        // Message lisible pour le formulaire d'import partagé.
        errors: report.errors,
      },
      message: report.errors.length ? undefined : `${report.imported} ligne(s) importée(s), ${report.duplicates} doublon(s) ignoré(s).`,
    };
  } catch (err) {
    return toActionError(err);
  }
}

export async function reconcileAction(transactionId: string, type: "payment" | "expense_payment", targetId: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    if (type !== "payment" && type !== "expense_payment") throw new AppError("VALIDATION", "Type invalide.");
    await reconcile(await getDb(), ctx, String(transactionId), { type, id: String(targetId) });
    revalidatePath("/tresorerie", "layout");
    return { ok: true, message: "Opération rapprochée." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function unreconcileAction(transactionId: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await unreconcile(await getDb(), ctx, String(transactionId));
    revalidatePath("/tresorerie", "layout");
    return { ok: true, message: "Rapprochement annulé." };
  } catch (err) {
    return toActionError(err);
  }
}
