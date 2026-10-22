import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Tractor } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { FilterTabs, Pagination, SortHeader, type SearchParams } from "@/components/data/list-controls";
import { SearchInput } from "@/components/data/search-input";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { getCompany } from "@/server/services/companies";
import { EQUIPMENT_SORTS, listEquipment } from "@/server/services/equipment";
import { parseListParams } from "@/server/services/listing";
import { EQUIPMENT_CATEGORIES, EQUIPMENT_CATEGORY_LABELS } from "@/lib/schemas";
import { formatDate } from "../ventes/sales-ui";
import { meterLabel, warrantyBadge } from "./equipment-ui";

export const metadata: Metadata = { title: "Parc matériel" };

const BASE = "/parc";
const linkBtn = "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium";

export default async function EquipmentListPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { ctx } = await requireCompanyContext();
  const db = await getDb();
  const base = parseListParams(params, EQUIPMENT_SORTS, "client");
  const category = EQUIPMENT_CATEGORIES.find((c) => c === params.categorie);
  const [{ rows, total, pageSize }, company] = await Promise.all([listEquipment(db, ctx, { ...base, category }), getCompany(db, ctx)]);
  const canWrite = can(ctx, "thirdparties.write");
  const filtered = !!(base.q || category || base.archived);
  const moduleOff = !company.modules.includes("parc");

  return (
    <>
      <PageHeader
        title="Parc matériel"
        description="Matériels vendus ou suivis, par client : identification, compteur, garantie."
        actions={
          canWrite && (
            <Link href="/parc/nouveau" className={`${linkBtn} bg-accent text-accent-foreground shadow-sm hover:bg-accent-hover`}>
              <Plus className="size-4" aria-hidden /> Ajouter un matériel
            </Link>
          )
        }
      />
      {moduleOff && (
        <p className="mb-4 rounded-md bg-muted px-3 py-2 text-[13px] text-foreground-muted">
          Le module Parc n&apos;est pas activé pour cette entreprise : il n&apos;apparaît pas dans le menu.{" "}
          <Link href="/parametres/entreprise#activite" className="font-medium text-accent hover:underline">
            Activer dans les paramètres
          </Link>
        </p>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <SearchInput placeholder="Rechercher client, marque, modèle, n° de série, immatriculation…" />
          <FilterTabs
            base={BASE}
            params={params}
            name="categorie"
            value={category ?? ""}
            options={[{ value: "", label: "Toutes catégories" }, ...EQUIPMENT_CATEGORIES.map((c) => ({ value: c, label: EQUIPMENT_CATEGORY_LABELS[c] }))]}
          />
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
            icon={<Tractor className="size-5" aria-hidden />}
            title={filtered ? "Aucun résultat" : "Parc vide"}
            description={filtered ? "Modifiez la recherche ou les filtres." : "Enregistrez les matériels vendus à vos clients pour suivre leur parc."}
            action={
              !filtered && canWrite ? (
                <Link href="/parc/nouveau" className={`${linkBtn} bg-accent text-accent-foreground hover:bg-accent-hover`}>
                  <Plus className="size-4" aria-hidden /> Ajouter un matériel
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <SortHeader base={BASE} params={params} column="marque" label="Matériel" activeSort={base.sort} dir={base.dir} />
                  <SortHeader base={BASE} params={params} column="client" label="Client" activeSort={base.sort} dir={base.dir} />
                  <th className="px-5 py-2.5 font-medium">Identification</th>
                  <th className="whitespace-nowrap px-5 py-2.5 text-right font-medium">Compteur</th>
                  <SortHeader base={BASE} params={params} column="vente" label="Vendu le" activeSort={base.sort} dir={base.dir} />
                  <th className="px-5 py-2.5 font-medium">Garantie</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-0 hover:bg-surface">
                    <td className="px-5 py-3">
                      <Link href={`/parc/${e.id}`} className="font-medium text-foreground hover:text-accent">
                        {e.brand} {e.model}
                      </Link>
                      <span className="ml-2 text-xs text-foreground-subtle">
                        {EQUIPMENT_CATEGORY_LABELS[e.category]}
                        {e.year ? ` · ${e.year}` : ""}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <Link href={`/tiers/${e.thirdPartyId}`} className="hover:text-accent">
                        {e.partyName}
                      </Link>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-foreground-muted">
                      {e.registration && <span className="mr-2">{e.registration}</span>}
                      {e.serialNumber ?? (e.registration ? "" : "—")}
                    </td>
                    <td className="tabular whitespace-nowrap px-5 py-3 text-right text-foreground-muted">{meterLabel(e.meterValue, e.meterUnit)}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-foreground-muted">{e.soldOn ? formatDate(e.soldOn) : "—"}</td>
                    <td className="whitespace-nowrap px-5 py-3">{warrantyBadge(e.warrantyEndsOn) ?? <span className="text-foreground-subtle">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination base={BASE} params={params} page={base.page} total={total} pageSize={pageSize} />
      </Card>
      <p className="mt-3 text-xs text-foreground-subtle">
        Depuis une facture émise, « Ajouter au parc du client » pré-remplit le client, la facture et la date de vente.
      </p>
    </>
  );
}
