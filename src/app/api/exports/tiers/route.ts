import { getDb } from "@/server/db/client";
import { getSession } from "@/server/http/session";
import { resolveCompanyContext } from "@/server/services/companies";
import { exportThirdPartiesCsv } from "@/server/services/third-parties";
import { csvResponse } from "@/server/http/csv-response";
import { isPartySection } from "@/lib/party-sections";

export const dynamic = "force-dynamic";

/** `?role=clients` ou `?role=fournisseurs` limite l'export à une rubrique ; sans paramètre, tous les tiers. */
export async function GET(request: Request) {
  const session = await getSession();
  const db = await getDb();
  const ctx = session ? await resolveCompanyContext(db, session.userId, session.activeCompanyId) : null;
  if (!ctx) return new Response("Non autorisé", { status: 401 });
  const role = new URL(request.url).searchParams.get("role");
  const section = isPartySection(role) ? role : undefined;
  return csvResponse(() => exportThirdPartiesCsv(db, ctx, section), section ?? "tiers");
}
