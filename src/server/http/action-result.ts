import "server-only";
import { ZodError } from "zod";
import { AppError } from "../errors";
import { logger } from "../logger";

/**
 * Résultat normalisé des Server Actions. Les erreurs internes ne sont jamais exposées :
 * elles sont journalisées avec un identifiant de corrélation communiqué à l'utilisateur.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof AppError) {
    return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
  }
  if (err instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, error: "Certains champs sont invalides.", fieldErrors };
  }
  // Les redirections Next.js sont des exceptions à laisser remonter.
  if (err && typeof err === "object" && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_")) {
    throw err;
  }
  const ref = logger.error("action.failed", err);
  return { ok: false, error: `Une erreur inattendue est survenue (réf. ${ref}).` };
}
