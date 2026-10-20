"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { addMember, changeMemberRole, createCompany, switchActiveCompany, updateCompany } from "@/server/services/companies";
import { verifyCompanyAuditChain, type ChainVerification } from "@/server/services/audit";
import { requireCompanyContext, requireSession } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import { MEMBER_ROLES } from "@/lib/schemas";
import { AppError } from "@/server/errors";

export async function createCompanyAction(values: unknown): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const db = await getDb();
    const company = await createCompany(db, session.userId, values);
    await switchActiveCompany(db, session.sessionId, session.userId, company.id);
  } catch (err) {
    return toActionError(err);
  }
  redirect("/parametres/entreprise?bienvenue=1");
}

export async function updateCompanyAction(values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await updateCompany(await getDb(), ctx, values);
    revalidatePath("/", "layout");
    return { ok: true, message: "Paramètres enregistrés." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function switchCompanyAction(companyId: string): Promise<ActionResult> {
  try {
    const session = await requireSession();
    await switchActiveCompany(await getDb(), session.sessionId, session.userId, String(companyId));
  } catch (err) {
    return toActionError(err);
  }
  redirect("/tableau-de-bord");
}

export async function addMemberAction(values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await addMember(await getDb(), ctx, values);
    revalidatePath("/parametres/utilisateurs");
    return { ok: true, message: "Membre ajouté." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function changeMemberRoleAction(userId: string, role: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const r = MEMBER_ROLES.find((x) => x === role);
    if (!r) throw new AppError("VALIDATION", "Rôle inconnu.");
    await changeMemberRole(await getDb(), ctx, String(userId), r);
    revalidatePath("/parametres/utilisateurs");
    return { ok: true, message: "Rôle modifié." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function verifyAuditAction(): Promise<ActionResult<ChainVerification>> {
  try {
    const { ctx } = await requireCompanyContext();
    const data = await verifyCompanyAuditChain(await getDb(), ctx);
    return { ok: true, data };
  } catch (err) {
    return toActionError(err);
  }
}
