import { randomUUID } from "node:crypto";

/**
 * Journal technique structuré (JSON sur stdout/stderr), exploitable par tout collecteur.
 * Ne jamais y écrire de mot de passe, jeton, IBAN complet ou donnée personnelle superflue.
 */
type Level = "info" | "warn" | "error";

function write(level: Level, event: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, data?: Record<string, unknown>) => write("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => write("warn", event, data),
  /** Journalise une erreur et retourne un identifiant de corrélation court. */
  error(event: string, err: unknown, data?: Record<string, unknown>): string {
    const ref = randomUUID().slice(0, 8);
    const e = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : { value: String(err) };
    write("error", event, { ref, error: e, ...data });
    return ref;
  },
};
