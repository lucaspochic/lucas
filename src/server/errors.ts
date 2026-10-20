/**
 * Erreurs métier. Le message est destiné à l'utilisateur (français, sans détail technique).
 * Toute autre exception est considérée comme une erreur interne : journalisée côté serveur,
 * remplacée par un message générique côté client.
 */
export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "IMMUTABLE";

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const forbidden = (message = "Vous n'avez pas les droits nécessaires pour cette action.") =>
  new AppError("FORBIDDEN", message);
export const notFound = (message = "Élément introuvable.") => new AppError("NOT_FOUND", message);
