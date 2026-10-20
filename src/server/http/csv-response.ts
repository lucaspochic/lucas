import "server-only";
import { AppError } from "../errors";
import { logger } from "../logger";
import { todayInParis } from "../domain/numbering";

/** Réponse de téléchargement CSV ; droits vérifiés par le service appelé. */
export async function csvResponse(produce: () => Promise<string>, name: string): Promise<Response> {
  try {
    const csv = await produce();
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}-${todayInParis()}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return new Response(err.message, { status: 403 });
    const ref = logger.error("export.failed", err, { name });
    return new Response(`Erreur lors de l'export (réf. ${ref}).`, { status: 500 });
  }
}
