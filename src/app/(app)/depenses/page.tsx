import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Receipt } from "lucide-react";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/card";
import { FilterTabs, Pagination, SortHeader, type SearchParams } from "@/components/data/list-controls";
import { SearchInput } from "@/components/data/search-input";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { EXPENSE_SORTS, listExpenses } from "@/server/services/expenses";
import { parseListParams } from "@/server/services/listing";
import { dec, formatEuro } from "@/server/domain/money";
import { todayInParis } from "@/server/domain/numbering";
import { formatDate } from "../ventes/sales-ui";

export const metadata: Metadata = { title: "Dépenses" };

const BASE = "/depenses";

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { ctx } = await requirePermission("purchases.read");
  const base = parseListParams(params, EXPENSE_SORTS, "date");
  const dir = params.ordre ? base.dir : "desc";
  const status = (["draft", "to_pay", "paid"] as const).find((s) => s === params.statut);
  const { rows, total, pageSize } = await listExpenses(await getDb(), ctx, { ...base, dir, status });
  const today = todayInParis();

  return (
    <>
      <PageHeader
        title="Dépenses"
        description="Factures fournisseurs : brouillon, validation (figée), paiements."
        actions={
          can(ctx, "purchases.write") && (
            <Link
              href="/depenses/nouveau"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-sm hover:bg-accent-hover"
            >
              <Plus className="size-4" aria-hidden /> Dépense
            </Link>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <SearchInput placeholder="Rechercher n°, référence, fournisseur…" />
          <FilterTabs
            base={BASE}
            params={params}
            name="statut"
            value={status ?? ""}
            options={[
              { value: "", label: "Toutes" },
              { value: "draft", label: "Brouillons" },
              { value: "to_pay", label: "À payer" },
              { value: "paid", label: "Payées" },
            ]}
          />
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={<Receipt className="size-5" aria-hidden />} title="Aucune dépense" description="Saisissez vos factures fournisseurs pour suivre vos charges, la TVA déductible et vos décaissements." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <SortHeader base={BASE} params={params} column="numero" label="N°" activeSort={base.sort} dir={dir} />
                  <SortHeader base={BASE} params={params} column="date" label="Date" activeSort={base.sort} dir={dir} />
                  <th className="px-5 py-2.5 font-medium">Fournisseur</th>
                  <th className="px-5 py-2.5 font-medium">Statut</th>
                  <th className="px-5 py-2.5 font-medium">Échéance</th>
                  <SortHeader base={BASE} params={params} column="montant" label="Total TTC" activeSort={base.sort} dir={dir} className="text-right" />
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const remaining = dec(e.totalInclTax).minus(e.amountPaid);
                  const late = e.status === "validated" && remaining.greaterThan(0) && e.dueDate && e.dueDate < today;
                  return (
                    <tr key={e.id} className="border-b border-border last:border-0 hover:bg-surface">
                      <td className="px-5 py-3">
                        <Link href={`/depenses/${e.id}`} className="whitespace-nowrap font-mono text-xs font-medium hover:text-accent">
                          {e.number ?? "Brouillon"}
                        </Link>
                        {e.supplierReference && <span className="ml-2 text-xs text-foreground-subtle">{e.supplierReference}</span>}
                      </td>
                      <td className="tabular px-5 py-3 text-foreground-muted">{formatDate(e.invoiceDate)}</td>
                      <td className="px-5 py-3">{e.partyName}</td>
                      <td className="px-5 py-3">
                        {e.status === "draft" ? (
                          <Badge>Brouillon</Badge>
                        ) : remaining.lte(0) ? (
                          <Badge tone="success">Payée</Badge>
                        ) : late ? (
                          <Badge tone="danger">En retard</Badge>
                        ) : (
                          <Badge tone="accent">À payer</Badge>
                        )}
                      </td>
                      <td className="tabular px-5 py-3 text-foreground-muted">{e.dueDate ? formatDate(e.dueDate) : "—"}</td>
                      <td className="tabular whitespace-nowrap px-5 py-3 text-right font-medium">{formatEuro(e.totalInclTax)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination base={BASE} params={params} page={base.page} total={total} pageSize={pageSize} />
      </Card>
    </>
  );
}
