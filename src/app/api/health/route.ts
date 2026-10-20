import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";

/** Sonde de santé : application démarrée et base joignable. Ne divulgue aucune information interne. */
export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok" });
  } catch (err) {
    logger.error("health.failed", err);
    return Response.json({ status: "error" }, { status: 503 });
  }
}
