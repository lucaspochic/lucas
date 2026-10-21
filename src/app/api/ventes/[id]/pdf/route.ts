import { getDb } from "@/server/db/client";
import { getSession } from "@/server/http/session";
import { resolveCompanyContext } from "@/server/services/companies";
import { exportPdf } from "@/server/services/einvoice";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";

/** PDF d'un document de vente émis, produit par le serveur. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const db = await getDb();
  const ctx = session ? await resolveCompanyContext(db, session.userId, session.activeCompanyId) : null;
  if (!ctx) return new Response("Non autorisé", { status: 401 });
  try {
    const { fileName, bytes } = await exportPdf(db, ctx, id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName.replace(/[^\w.-]/g, "_")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const ref = logger.error("pdf.export_failed", err);
    return new Response(`Erreur lors de l'export (réf. ${ref}).`, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
