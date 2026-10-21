/**
 * Exécute des requêtes l'une après l'autre. À utiliser à la place de Promise.all lorsque
 * l'exécuteur peut être une transaction : elle ne dispose que d'une connexion, sur laquelle
 * des requêtes simultanées sont dépréciées par le pilote PostgreSQL (refusées en pg 9).
 * Les requêtes Drizzle sont paresseuses (exécutées à l'attente) ; un appel de fonction
 * asynchrone doit être passé sous forme de fonction pour ne démarrer qu'à son tour.
 */
export async function inSequence<T extends readonly unknown[]>(items: { [K in keyof T]: PromiseLike<T[K]> | (() => PromiseLike<T[K]>) }): Promise<T> {
  const out: unknown[] = [];
  for (const item of items as readonly (PromiseLike<unknown> | (() => PromiseLike<unknown>))[]) {
    out.push(await (typeof item === "function" ? item() : item));
  }
  return out as unknown as T;
}
