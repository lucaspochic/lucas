"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import {
  addContact,
  createThirdParty,
  importThirdPartiesCsv,
  removeContact,
  setThirdPartyArchived,
  updateThirdParty,
  type ImportReport,
} from "@/server/services/third-parties";
import { CSV_MAX_BYTES } from "@/server/domain/csv";
import { AppError } from "@/server/errors";

export async function createThirdPartyAction(values: unknown): Promise<ActionResult> {
  let id: string;
  try {
    const { ctx } = await requireCompanyContext();
    id = (await createThirdParty(await getDb(), ctx, values)).id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/tiers/${id}?cree=1`);
}

export async function updateThirdPartyAction(id: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await updateThirdParty(await getDb(), ctx, String(id), values);
    revalidatePath(`/tiers/${id}`);
    return { ok: true, message: "Fiche enregistrée." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function archiveThirdPartyAction(id: string, archived: boolean): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await setThirdPartyArchived(await getDb(), ctx, String(id), archived === true);
    revalidatePath("/tiers");
    revalidatePath(`/tiers/${id}`);
    return { ok: true, message: archived ? "Tiers archivé." : "Tiers restauré." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function addContactAction(thirdPartyId: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await addContact(await getDb(), ctx, String(thirdPartyId), values);
    revalidatePath(`/tiers/${thirdPartyId}`);
    return { ok: true, message: "Contact ajouté." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function removeContactAction(thirdPartyId: string, contactId: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await removeContact(await getDb(), ctx, String(contactId));
    revalidatePath(`/tiers/${thirdPartyId}`);
    return { ok: true, message: "Contact supprimé." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function importThirdPartiesAction(content: string): Promise<ActionResult<ImportReport>> {
  try {
    const { ctx } = await requireCompanyContext();
    if (typeof content !== "string" || content.length > CSV_MAX_BYTES) {
      throw new AppError("VALIDATION", "Fichier trop volumineux (2 Mo au maximum).");
    }
    const report = await importThirdPartiesCsv(await getDb(), ctx, content);
    if (report.imported > 0) revalidatePath("/tiers");
    return { ok: true, data: report };
  } catch (err) {
    return toActionError(err);
  }
}
