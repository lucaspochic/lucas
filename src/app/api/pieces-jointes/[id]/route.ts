import { getDb } from "@/server/db/client";
import { getSession } from "@/server/http/session";
import { resolveCompanyContext } from "@/server/services/companies";
import { readAttachment } from "@/server/services/attachments";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";

/**
 * Consultation d'une pièce jointe (affichage dans le navigateur, ou téléchargement avec
 * ?telecharger=1). Type réel détecté à l'enregistrement ; images isolées (CSP « sandbox »).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const db = await getDb();
  const ctx = session ? await resolveCompanyContext(db, session.userId, session.activeCompanyId) : null;
  if (!ctx) return new Response("Non autorisé", { status: 401 });
  try {
    const { row, data } = await readAttachment(db, ctx, id);
    const download = new URL(request.url).searchParams.has("telecharger");
    // Nom ASCII de repli (anciens navigateurs) + nom UTF-8 exact (RFC 6266).
    const ascii = row.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(row.fileName);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": row.mimeType,
        "Content-Length": String(data.length),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
        // Images isolées ; un PDF ne peut pas l'être (le lecteur intégré du navigateur refuse le mode « sandbox »).
        ...(row.mimeType.startsWith("image/") ? { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'" } : {}),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.code === "FORBIDDEN" ? 403 : 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const ref = logger.error("attachment.read_failed", err);
    return new Response(`Pièce jointe indisponible (réf. ${ref}).`, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
