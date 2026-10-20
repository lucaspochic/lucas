import type { Metadata } from "next";
import Link from "next/link";
import { Download, Package, Plus, Upload } from "lucide-react";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/card";
import { FilterTabs, Pagination, SortHeader, type SearchParams } from "@/components/data/list-controls";
import { SearchInput } from "@/components/data/search-input";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { listCategories, listProducts, PRODUCT_SORTS } from "@/server/services/products";
import { parseListParams } from "@/server/services/listing";
import { formatEuro, formatRate, formatUnitPrice } from "@/server/domain/money";

export const metadata: Metadata = { title: "Produits & services" };

const BASE = "/catalogue";
const linkBtn = "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium";

export default async function CatalogPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { ctx } = await requireCompanyContext();
  const db = await getDb();
  const base = parseListParams(params, PRODUCT_SORTS, "reference");
  const kind = params.nature === "good" || params.nature === "service" ? params.nature : undefined;
  const categories = await listCategories(db, ctx);
  const category = categories.find((c) => c === params.categorie);
  const { rows, total, pageSize } = await listProducts(db, ctx, { ...base, kind, category });
  const canWrite = can(ctx, "catalog.write");
  const filtered = !!(base.q || kind || category || base.archived);

  return (
    <>
      <PageHeader
        title="Produits & services"
        description="Catalogue des articles vendus : prix HT, taux de TVA, unités."
        actions={
          <>
            {can(ctx, "exports.run") && (
              <a href="/api/exports/catalogue" className={`${linkBtn} text-foreground-muted hover:bg-muted`}>
                <Download className="size-4" aria-hidden /> Exporter
              </a>
            )}
            {canWrite && (
              <>
                <Link href="/catalogue/import" className={`${linkBtn} text-foreground-muted hover:bg-muted`}>
                  <Upload className="size-4" aria-hidden /> Importer
                </Link>
                <Link href="/catalogue/nouveau" className={`${linkBtn} bg-accent text-accent-foreground shadow-sm hover:bg-accent-hover`}>
                  <Plus className="size-4" aria-hidden /> Nouvel article
                </Link>
              </>
            )}
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <SearchInput placeholder="Rechercher référence, désignation, code-barres…" />
          <FilterTabs
            base={BASE}
            params={params}
            name="nature"
            value={kind ?? ""}
            options={[
              { value: "", label: "Tous" },
              { value: "good", label: "Biens" },
              { value: "service", label: "Services" },
            ]}
          />
          {categories.length > 0 && (
            <FilterTabs
              base={BASE}
              params={params}
              name="categorie"
              value={category ?? ""}
              options={[{ value: "", label: "Toutes catégories" }, ...categories.slice(0, 8).map((c) => ({ value: c, label: c }))]}
            />
          )}
          <FilterTabs
            base={BASE}
            params={params}
            name="archives"
            value={base.archived ? "1" : ""}
            options={[
              { value: "", label: "Actifs" },
              { value: "1", label: "Archivés" },
            ]}
          />
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<Package className="size-5" aria-hidden />}
            title={filtered ? "Aucun résultat" : "Catalogue vide"}
            description={filtered ? "Modifiez la recherche ou les filtres." : "Ajoutez vos produits et prestations, ou importez-les depuis un fichier CSV."}
            action={
              !filtered && canWrite ? (
                <Link href="/catalogue/nouveau" className={`${linkBtn} bg-accent text-accent-foreground hover:bg-accent-hover`}>
                  <Plus className="size-4" aria-hidden /> Nouvel article
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <SortHeader base={BASE} params={params} column="reference" label="Référence" activeSort={base.sort} dir={base.dir} />
                  <SortHeader base={BASE} params={params} column="nom" label="Désignation" activeSort={base.sort} dir={base.dir} />
                  <th className="px-5 py-2.5 font-medium">Nature</th>
                  <SortHeader base={BASE} params={params} column="prix" label="Prix HT" activeSort={base.sort} dir={base.dir} className="text-right" />
                  <th className="px-5 py-2.5 text-right font-medium">TVA</th>
                  <th className="whitespace-nowrap px-5 py-2.5 text-right font-medium">Prix TTC</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0 hover:bg-surface">
                    <td className="px-5 py-3 font-mono text-xs text-foreground-muted">{p.reference}</td>
                    <td className="px-5 py-3">
                      <Link href={`/catalogue/${p.id}`} className="font-medium text-foreground hover:text-accent">
                        {p.name}
                      </Link>
                      {p.category && <span className="ml-2 text-xs text-foreground-subtle">{p.category}</span>}
                    </td>
                    <td className="px-5 py-3">
                      <Badge>{p.kind === "good" ? "Bien" : "Service"}</Badge>
                    </td>
                    <td className="tabular whitespace-nowrap px-5 py-3 text-right">
                      {formatUnitPrice(p.unitPriceExclTax)}
                      <span className="text-foreground-subtle"> / {p.unit}</span>
                    </td>
                    <td className="tabular whitespace-nowrap px-5 py-3 text-right text-foreground-muted">{formatRate(p.vatRate)}</td>
                    <td className="tabular whitespace-nowrap px-5 py-3 text-right font-medium">{formatEuro(p.priceInclTax)}</td>
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
