"use server";

import { revalidatePath } from "next/cache";
import { renderSVG } from "uqr";
import { getDb } from "@/server/db/client";
import { requireSession } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import { confirmMfaEnrollment, disableMfa, regenerateRecoveryCodes, startMfaEnrollment } from "@/server/services/mfa";
import type { CredentialFormState } from "./auth";

export async function startMfaAction(): Promise<ActionResult<{ secret: string; qrSvg: string }>> {
  try {
    const session = await requireSession();
    const { secret, uri } = await startMfaEnrollment(await getDb(), session);
    // QR code rendu côté serveur (SVG, noir sur blanc pour rester lisible en thème sombre).
    return { ok: true, data: { secret, qrSvg: renderSVG(uri, { pixelSize: 5, border: 2 }) } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function confirmMfaAction(code: string): Promise<ActionResult<{ codes: string[] }>> {
  try {
    const session = await requireSession();
    const codes = await confirmMfaEnrollment(await getDb(), session, String(code));
    revalidatePath("/parametres/securite");
    return { ok: true, data: { codes }, message: "Double authentification activée." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function regenerateRecoveryCodesAction(code: string): Promise<ActionResult<{ codes: string[] }>> {
  try {
    const session = await requireSession();
    const codes = await regenerateRecoveryCodes(await getDb(), session, String(code));
    revalidatePath("/parametres/securite");
    return { ok: true, data: { codes }, message: "Nouveaux codes de secours générés ; les précédents ne sont plus valables." };
  } catch (err) {
    return toActionError(err);
  }
}

/** Désactivation : formulaire avec mot de passe, en amélioration progressive (POST garanti). */
export async function disableMfaFormAction(_prev: CredentialFormState, fd: FormData): Promise<CredentialFormState> {
  try {
    const session = await requireSession();
    await disableMfa(await getDb(), session, { password: String(fd.get("password") ?? ""), code: String(fd.get("code") ?? "") });
  } catch (err) {
    const r = toActionError(err);
    return r.ok ? {} : { error: r.error, fieldErrors: r.fieldErrors };
  }
  revalidatePath("/parametres/securite");
  return { restart: true };
}
