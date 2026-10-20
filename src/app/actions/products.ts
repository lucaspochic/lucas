"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import { createProduct, importProductsCsv, setProductArchived, updateProduct } from "@/server/services/products";
import type { ImportReport } from "@/server/services/third-parties";
import { CSV_MAX_BYTES } from "@/server/domain/csv";
import { AppError } from "@/server/errors";

export async function createProductAction(values: unknown): Promise<ActionResult> {
  let id: string;
  try {
    const { ctx } = await requireCompanyContext();
    id = (await createProduct(await getDb(), ctx, values)).id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/catalogue/${id}?cree=1`);
}

export async function updateProductAction(id: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await updateProduct(await getDb(), ctx, String(id), values);
    revalidatePath(`/catalogue/${id}`);
    return { ok: true, message: "Article enregistré." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function archiveProductAction(id: string, archived: boolean): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await setProductArchived(await getDb(), ctx, String(id), archived === true);
    revalidatePath("/catalogue");
    revalidatePath(`/catalogue/${id}`);
    return { ok: true, message: archived ? "Article archivé." : "Article restauré." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function importProductsAction(content: string): Promise<ActionResult<ImportReport>> {
  try {
    const { ctx } = await requireCompanyContext();
    if (typeof content !== "string" || content.length > CSV_MAX_BYTES) {
      throw new AppError("VALIDATION", "Fichier trop volumineux (2 Mo au maximum).");
    }
    const report = await importProductsCsv(await getDb(), ctx, content);
    if (report.imported > 0) revalidatePath("/catalogue");
    return { ok: true, data: report };
  } catch (err) {
    return toActionError(err);
  }
}
