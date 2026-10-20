"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { login, logout, registerUser, changePassword } from "@/server/services/auth";
import { clearSessionCookie, readSessionToken, requestMeta, requireSession, setSessionCookie } from "@/server/http/session";
import { toActionError, type ActionResult } from "@/server/http/action-result";
import { AppError } from "@/server/errors";

const ttlHours = () => Number(process.env.SESSION_TTL_HOURS ?? 12);

export async function loginAction(values: unknown): Promise<ActionResult> {
  try {
    const db = await getDb();
    const { token, expiresAt } = await login(db, values, { ...(await requestMeta()), ttlHours: ttlHours() });
    await setSessionCookie(token, expiresAt);
  } catch (err) {
    return toActionError(err);
  }
  redirect("/tableau-de-bord");
}

export async function registerAction(values: unknown): Promise<ActionResult> {
  try {
    if (process.env.ALLOW_SELF_SIGNUP === "false") {
      throw new AppError("FORBIDDEN", "La création de compte est désactivée. Contactez l'administrateur.");
    }
    const db = await getDb();
    const meta = await requestMeta();
    await registerUser(db, values, meta);
    const v = values as { email: string; password: string };
    const { token, expiresAt } = await login(db, { email: v.email, password: v.password }, { ...meta, ttlHours: ttlHours() });
    await setSessionCookie(token, expiresAt);
  } catch (err) {
    return toActionError(err);
  }
  redirect("/onboarding");
}

export async function logoutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) await logout(await getDb(), token);
  await clearSessionCookie();
  redirect("/login");
}

export async function changePasswordAction(values: unknown): Promise<ActionResult> {
  try {
    const session = await requireSession();
    await changePassword(await getDb(), session, values);
    await clearSessionCookie();
  } catch (err) {
    return toActionError(err);
  }
  redirect("/login?motdepasse=modifie");
}
