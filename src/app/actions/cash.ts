"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import { closeSession, closeToday, createRegister, getRegister, openSession, recordTicket, refundTicket, verifyRegister } from "@/server/services/cash";
import { assertPermission } from "@/server/security/permissions";
import { dec, formatEuro } from "@/server/domain/money";

export async function createRegisterAction(values: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const { ctx } = await requireCompanyContext();
    const register = await createRegister(await getDb(), ctx, values);
    revalidatePath("/caisse");
    return { ok: true, data: { id: register.id }, message: `Caisse ${register.code} créée.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function openSessionAction(registerId: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    await openSession(await getDb(), ctx, String(registerId), values);
    revalidatePath(`/caisse/${registerId}`);
    return { ok: true, message: "Caisse ouverte." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function closeSessionAction(registerId: string, values: unknown): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const session = await closeSession(await getDb(), ctx, String(registerId), values);
    revalidatePath(`/caisse/${registerId}`);
    const diff = dec(session.difference!);
    const gap = diff.isZero() ? "aucun écart" : `écart de ${formatEuro(diff)} comptabilisé (${diff.isNegative() ? "manquant, 658" : "excédent, 758"})`;
    return { ok: true, message: `Session fermée : espèces attendues ${formatEuro(session.expectedCash!)}, ${gap}.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function recordTicketAction(registerId: string, values: unknown): Promise<ActionResult<{ id: string; number: string; total: string }>> {
  try {
    const { ctx } = await requireCompanyContext();
    const { result } = await recordTicket(await getDb(), ctx, String(registerId), values);
    revalidatePath(`/caisse/${registerId}`);
    return { ok: true, data: { id: result.id, number: result.number, total: result.totalInclTax } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function refundTicketAction(ticketId: string, values: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const { ctx } = await requireCompanyContext();
    const { result } = await refundTicket(await getDb(), ctx, String(ticketId), values);
    revalidatePath(`/caisse/${result.registerId}`);
    revalidatePath(`/caisse/tickets/${ticketId}`);
    return { ok: true, data: { id: result.id }, message: `Remboursement ${result.number} enregistré.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function closeTodayAction(registerId: string): Promise<ActionResult> {
  try {
    const { ctx } = await requireCompanyContext();
    const created = await closeToday(await getDb(), ctx, String(registerId));
    revalidatePath(`/caisse/${registerId}`);
    return { ok: true, message: created.length ? `${created.length} clôture(s) enregistrée(s).` : "Aucune période à clôturer." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function verifyRegisterAction(registerId: string): Promise<ActionResult<{ valid: boolean; tickets: number; closures: number; errors: string[] }>> {
  try {
    const { ctx } = await requireCompanyContext();
    assertPermission(ctx, "cash.close");
    const db = await getDb();
    // Contrôle d'appartenance : getRegister lève « introuvable » pour une autre entreprise.
    await getRegister(db, ctx, String(registerId));
    return { ok: true, data: await verifyRegister(db, ctx.companyId, String(registerId)) };
  } catch (err) {
    return toActionError(err);
  }
}
