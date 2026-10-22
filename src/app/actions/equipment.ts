"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import { createEquipment, invoicesOfParty, setEquipmentArchived, updateEquipment } from "@/server/services/equipment";

export interface InvoiceOption {
  id: string;
  number: string | null;
  issueDate: string | null;
}

export async function createEquipmentAction(values: unknown): Promise<ActionResult> {
  let id: string;
  try {
    const { ctx } = await requireCompanyContext();
    id = (await createEquipment(await getDb(), ctx, values)).id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/parc/${id}?cree=1`);
}

export async function updateEquipmentAction(id: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await updateEquipment(await getDb(), ctx, String(id), values);
    revalidatePath(`/parc/${id}`);
    return { ok: true, message: "Matériel enregistré." };
  } catch (err) {
    return toActionError(err);
  }
}

/** Factures émises au client choisi, pour la liste « Facture de vente » du formulaire. */
export async function invoicesOfPartyAction(thirdPartyId: string): Promise<ActionResult<InvoiceOption[]>> {
  try {
    const { ctx } = await requireCompanyContext();
    const rows = await invoicesOfParty(await getDb(), ctx, String(thirdPartyId));
    return { ok: true, data: rows.map((r) => ({ id: r.id, number: r.number, issueDate: r.issueDate })) };
  } catch (err) {
    return toActionError(err);
  }
}

export async function archiveEquipmentAction(id: string, archived: boolean): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await setEquipmentArchived(await getDb(), ctx, String(id), archived === true);
    revalidatePath("/parc");
    revalidatePath(`/parc/${id}`);
    return { ok: true, message: archived ? "Matériel archivé." : "Matériel restauré." };
  } catch (err) {
    return toActionError(err);
  }
}
