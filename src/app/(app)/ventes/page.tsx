import type { Metadata } from "next";
import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { FilterTabs, Pagination, SortHeader, type SearchParams } from "@/components/data/list-controls";
import { SearchInput } from "@/components/data/search-input";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { listSalesDocuments, SALES_SORTS } from "@/server/services/sales";
import { parseListParams } from "@/server/services/listing";
import { formatEuro } from "@/server/domain/money";
import { DOCUMENT_TYPE_LABELS } from "@/server/domain/sales";
import { StatusBadge, formatDate } from "./sales-ui";
import { invoiceBalances } from "@/server/services/payments";
import { PaymentStatusBadge } from "../reglements/payment-ui";

export const metadata: Metadata = { title: "Devis & factures" };

const BASE = "/ventes";
const TYPES = { factures: "invoice", devis: "quote", avoirs: "credit_note" } as const;
const STATUSES = ["draft", "issued", "accepted", "refused"] as const;
const linkBtn = "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium";

export default async function SalesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { ctx } = await requireCompanyContext();
  const tab = (Object.keys(TYPES) as (keyof typeof TYPES)[]).find((k) => k === params.type) ?? "factures";
  const type = TYPES[tab];
  const status = STATUSES.find((s) => s === params.statut);
  const base = parseListParams(params, SALES_SORTS, "date");
  const dir = params.ordre ? base.dir : "desc";
  const db = await getDb();
  const { rows, total, pageSize } = await listSalesDocuments(db, ctx, { ...base, dir, type, status });
  const issuedIds = type === "invoice" ? rows.filter((r) => r.status !== "draft").map((r) => r.id) : [];
  const balances = issuedIds.length ? await invoiceBalances(db, ctx, { ids: issuedIds }) : [];
  const canWrite = can(ctx, "sales.write");

  return (
    <>
      <PageHeader
        title="Devis & factures"
        description="Brouillons modifiables, documents émis numérotés et figés, avoirs."
        actions={
          canWrite && (
            <>
              <Link href="/ventes/nouveau?type=devis" className={`${linkBtn} text-foreground-muted hover:bg-muted`}>
                <Plus className="size-4" aria-hidden /> Devis
              </Link>
              <Link href="/ventes/nouveau?type=facture" className={`${linkBtn} bg-accent text-accent-foreground shadow-sm hover:bg-accent-hover`}>
                <Plus className="size-4" aria-hidden /> Facture
              </Link>
            </>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <FilterTabs
            base={BASE}
            params={{ ...params, statut: undefined, page: undefined }}
            name="type"
            value={tab}
            options={[
              { value: "factures", label: "Factures" },
              { value: "devis", label: "Devis" },
              { value: "avoirs", label: "Avoirs" },
            ]}
          />
          <SearchInput placeholder="Rechercher numéro, client…" />
          <FilterTabs
            base={BASE}
            params={params}
            name="statut"
            value={status ?? ""}
            options={[
              { value: "", label: "Tous" },
              { value: "draft", label: "Brouillons" },
              { value: "issued", label: "Émis" },
              ...(type === "quote"
                ? [
                    { value: "accepted", label: "Acceptés" },
                    { value: "refused", label: "Refusés" },
                  ]
                : []),
            ]}
          />
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-5" aria-hidden />}
            title={`Aucun ${DOCUMENT_TYPE_LABELS[type].toLowerCase()}`}
            description={
              type === "credit_note"
                ? "Les avoirs s'établissent depuis une facture émise."
                : "Créez un document : il reste un brouillon modifiable jusqu'à son émission."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <SortHeader base={BASE} params={params} column="numero" label="Numéro" activeSort={base.sort} dir={dir} />
                  <SortHeader base={BASE} params={params} column="date" label="Date" activeSort={base.sort} dir={dir} />
                  <th className="px-5 py-2.5 font-medium">Client</th>
                  <th className="px-5 py-2.5 font-medium">Statut</th>
                  <th className="px-5 py-2.5 font-medium">{type === "quote" ? "Validité" : type === "invoice" ? "Échéance" : ""}</th>
                  <SortHeader base={BASE} params={params} column="montant" label="Total TTC" activeSort={base.sort} dir={dir} className="text-right" />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className="border-b border-border last:border-0 hover:bg-surface">
                    <td className="px-5 py-3">
                      <Link href={`/ventes/${d.id}`} className="whitespace-nowrap font-mono text-xs font-medium text-foreground hover:text-accent">
                        {d.number ?? "Brouillon"}
                      </Link>
                    </td>
                    <td className="tabular px-5 py-3 text-foreground-muted">{d.issueDate ? formatDate(d.issueDate) : "—"}</td>
                    <td className="px-5 py-3">{d.partyName}</td>
                    <td className="px-5 py-3">
                      {(() => {
                        const b = balances.find((x) => x.id === d.id);
                        return b ? <PaymentStatusBadge status={b.status} /> : <StatusBadge status={d.status} />;
                      })()}
                    </td>
                    <td className="tabular px-5 py-3 text-foreground-muted">{d.dueDate ? formatDate(d.dueDate) : "—"}</td>
                    <td className="tabular whitespace-nowrap px-5 py-3 text-right font-medium">{formatEuro(d.totalInclTax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination base={BASE} params={params} page={base.page} total={total} pageSize={pageSize} />
      </Card>
    </>
  );
}
