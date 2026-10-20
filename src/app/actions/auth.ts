"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { login, logout, registerUser, changePassword } from "@/server/services/auth";
import { clearSessionCookie, readSessionToken, requestMeta, requireSession, setSessionCookie } from "@/server/http/session";
import { toActionError } from "@/server/http/action-result";
import { AppError } from "@/server/errors";

/**
 * Les formulaires contenant un mot de passe utilisent l'amélioration progressive :
 * <form action={action}> envoie un POST même si le JavaScript de la page n'est pas encore
 * chargé. Un envoi natif par défaut (GET) mettrait le mot de passe dans l'URL, donc dans
 * l'historique et les journaux. Les mots de passe ne sont jamais renvoyés au navigateur.
 */
export interface CredentialFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Valeurs non sensibles à réafficher après une erreur. */
  values?: { email?: string; fullName?: string };
}

const ttlHours = () => Number(process.env.SESSION_TTL_HOURS ?? 12);
const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
};

function failure(err: unknown, values: CredentialFormState["values"]): CredentialFormState {
  const r = toActionError(err);
  return r.ok ? {} : { error: r.error, fieldErrors: r.fieldErrors, values };
}

export async function loginFormAction(_prev: CredentialFormState, fd: FormData): Promise<CredentialFormState> {
  const email = field(fd, "email");
  try {
    const db = await getDb();
    const { token, expiresAt } = await login(db, { email, password: field(fd, "password") }, { ...(await requestMeta()), ttlHours: ttlHours() });
    await setSessionCookie(token, expiresAt);
  } catch (err) {
    return failure(err, { email });
  }
  redirect("/tableau-de-bord");
}

export async function registerFormAction(_prev: CredentialFormState, fd: FormData): Promise<CredentialFormState> {
  const values = { fullName: field(fd, "fullName"), email: field(fd, "email") };
  try {
    if (process.env.ALLOW_SELF_SIGNUP === "false") {
      throw new AppError("FORBIDDEN", "La création de compte est désactivée. Contactez l'administrateur.");
    }
    const db = await getDb();
    const meta = await requestMeta();
    const password = field(fd, "password");
    await registerUser(db, { ...values, password }, meta);
    const { token, expiresAt } = await login(db, { email: values.email, password }, { ...meta, ttlHours: ttlHours() });
    await setSessionCookie(token, expiresAt);
  } catch (err) {
    return failure(err, values);
  }
  redirect("/onboarding");
}

export async function logoutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) await logout(await getDb(), token);
  await clearSessionCookie();
  redirect("/login");
}

export async function changePasswordFormAction(_prev: CredentialFormState, fd: FormData): Promise<CredentialFormState> {
  try {
    const session = await requireSession();
    await changePassword(await getDb(), session, {
      currentPassword: field(fd, "currentPassword"),
      newPassword: field(fd, "newPassword"),
      confirmPassword: field(fd, "confirmPassword"),
    });
    await clearSessionCookie();
  } catch (err) {
    return failure(err, {});
  }
  redirect("/login?motdepasse=modifie");
}
