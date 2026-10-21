import type { Metadata } from "next";
import { getDb } from "@/server/db/client";
import { orNotFound, requireCompanyContext } from "@/server/http/session";
import { reminderPreview } from "@/server/services/reminders";
import { formatDate } from "@/app/(app)/ventes/sales-ui";
import { todayInParis } from "@/server/domain/numbering";
import { PrintButton } from "../../ventes/[id]/print-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Lettre de relance" } };

/** Lettre de relance imprimable (modèle à relire avant envoi). */
export default async function PrintReminderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ niveau?: string }> }) {
  const { id } = await params;
  const level = Math.min(3, Math.max(1, Number((await searchParams).niveau) || 1)) as 1 | 2 | 3;
  const { ctx } = await requireCompanyContext();
  const { letter, seller, customer } = await orNotFound(reminderPreview(await getDb(), ctx, id, level));
  return (
    <main className="min-h-screen bg-[#f1f3f6] py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] justify-end print:hidden">
        <PrintButton />
      </div>
      <article className="mx-auto max-w-[210mm] bg-white p-12 text-[13px] leading-relaxed text-[#1f2430] shadow-card print:shadow-none">
        <header className="flex justify-between gap-8">
          <div>
            <p className="font-semibold">{seller.tradeName || seller.legalName}</p>
            {seller.address.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
          <div className="pt-16 text-right">
            <p className="font-medium">{customer.name}</p>
            {customer.billingAddress.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
        </header>
        <p className="mt-10 text-right">Le {formatDate(todayInParis())}</p>
        <p className="mt-6 font-semibold">Objet : {letter.subject}</p>
        {level === 3 && <p className="mt-1 text-[12px]">Lettre recommandée avec accusé de réception</p>}
        <div className="mt-6 space-y-4 whitespace-pre-line">{letter.body}</div>
      </article>
    </main>
  );
}
