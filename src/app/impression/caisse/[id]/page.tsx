import type { Metadata } from "next";
import { getDb } from "@/server/db/client";
import { orNotFound, requireCompanyContext } from "@/server/http/session";
import { getTicket } from "@/server/services/cash";
import { Receipt } from "@/app/(app)/caisse/receipt";
import { PrintButton } from "../../ventes/[id]/print-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Ticket de caisse" } };

/** Ticket imprimable (imprimante 80 mm ou PDF du navigateur). */
export default async function PrintTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireCompanyContext();
  const view = await orNotFound(getTicket(await getDb(), ctx, id));
  return (
    <main className="min-h-screen bg-[#f1f3f6] py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[80mm] justify-center print:hidden">
        <PrintButton />
      </div>
      <div className="shadow-card print:shadow-none">
        <Receipt view={view} />
      </div>
    </main>
  );
}
