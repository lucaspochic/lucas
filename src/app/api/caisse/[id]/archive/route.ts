import { getDb } from "@/server/db/client";
import { getSession } from "@/server/http/session";
import { resolveCompanyContext } from "@/server/services/companies";
import { exportArchive } from "@/server/services/cash";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";

/**
 * Production d'une archive de caisse (ZIP signé) pour une période clôturée.
 * POST (formulaire) : l'opération est enregistrée (table cash_archives + journal d'audit).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const db = await getDb();
  const ctx = session ? await resolveCompanyContext(db, session.userId, session.activeCompanyId) : null;
  if (!ctx) return new Response("Non autorisé", { status: 401 });
  const form = await request.formData();
  const from = String(form.get("from") ?? "");
  const to = String(form.get("to") ?? "");
  try {
    const archive = await exportArchive(db, ctx, id, from, to);
    return new Response(new Uint8Array(archive.zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${archive.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.code === "FORBIDDEN" ? 403 : err.code === "NOT_FOUND" ? 404 : 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const ref = logger.error("cash.archive_failed", err);
    return new Response(`Erreur lors de la production de l'archive (réf. ${ref}).`, { status: 500 });
  }
}
