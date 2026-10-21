import { getDb } from "@/server/db/client";
import { getSession } from "@/server/http/session";
import { resolveCompanyContext } from "@/server/services/companies";
import { exportFec } from "@/server/services/accounting-reports";
import { appendAuditEvent } from "@/server/services/audit";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";

/** Téléchargement du FEC d'un exercice (?exercice=2026). L'export est tracé dans le journal d'audit. */
export async function GET(request: Request) {
  const session = await getSession();
  const db = await getDb();
  const ctx = session ? await resolveCompanyContext(db, session.userId, session.activeCompanyId) : null;
  if (!ctx) return new Response("Non autorisé", { status: 401 });
  const year = Number(new URL(request.url).searchParams.get("exercice"));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return new Response("Exercice invalide", { status: 400 });
  try {
    const fec = await exportFec(db, ctx, year);
    await db.transaction((tx) =>
      appendAuditEvent(tx, {
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: "accounting.fec_exported",
        entityType: "fec",
        entityId: String(year),
        payload: { filename: fec.filename, lines: fec.lineCount },
      }),
    );
    return new Response(fec.content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fec.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.code === "FORBIDDEN" ? 403 : 400 });
    const ref = logger.error("fec.export_failed", err);
    return new Response(`Erreur lors de l'export (réf. ${ref}).`, { status: 500 });
  }
}
