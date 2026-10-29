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
import { isPartySection, partyHref, PARTY_SECTIONS } from "@/lib/party-sections";

/** Une fiche est visible sous /clients et /fournisseurs : les deux vues sont rafraîchies. */
function revalidateParty(id?: string) {
  for (const section of PARTY_SECTIONS) revalidatePath(id ? `/${section}/${id}` : `/${section}`);
}

export async function createThirdPartyAction(values: unknown, section?: unknown): Promise<ActionResult> {
  let href: string;
  try {
    const { ctx } = await requireCompanyContext();
    const party = await createThirdParty(await getDb(), ctx, values);
    href = partyHref(party, isPartySection(section) ? section : undefined);
  } catch (err) {
    return toActionError(err);
  }
  redirect(`${href}?cree=1`);
}

export async function updateThirdPartyAction(id: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await updateThirdParty(await getDb(), ctx, String(id), values);
    revalidateParty(id);
    return { ok: true, message: "Fiche enregistrée." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function archiveThirdPartyAction(id: string, archived: boolean): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await setThirdPartyArchived(await getDb(), ctx, String(id), archived === true);
    revalidateParty();
    revalidateParty(id);
    return { ok: true, message: archived ? "Tiers archivé." : "Tiers restauré." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function addContactAction(thirdPartyId: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await addContact(await getDb(), ctx, String(thirdPartyId), values);
    revalidateParty(thirdPartyId);
    return { ok: true, message: "Contact ajouté." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function removeContactAction(thirdPartyId: string, contactId: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await removeContact(await getDb(), ctx, String(contactId));
    revalidateParty(thirdPartyId);
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
    if (report.imported > 0) revalidateParty();
    return { ok: true, data: report };
  } catch (err) {
    return toActionError(err);
  }
}
