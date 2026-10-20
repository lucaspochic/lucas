import { getDb } from "@/server/db/client";
import { getSession } from "@/server/http/session";
import { resolveCompanyContext } from "@/server/services/companies";
import { exportThirdPartiesCsv } from "@/server/services/third-parties";
import { csvResponse } from "@/server/http/csv-response";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  const db = await getDb();
  const ctx = session ? await resolveCompanyContext(db, session.userId, session.activeCompanyId) : null;
  if (!ctx) return new Response("Non autorisé", { status: 401 });
  return csvResponse(() => exportThirdPartiesCsv(db, ctx), "tiers");
}
