import type { Metadata } from "next";
import Link from "next/link";
import { Download, Plus, Upload, Users } from "lucide-react";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/card";
import { FilterTabs, Pagination, SortHeader, type SearchParams } from "@/components/data/list-controls";
import { SearchInput } from "@/components/data/search-input";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { listThirdParties, THIRD_PARTY_SORTS } from "@/server/services/third-parties";
import { parseListParams } from "@/server/services/listing";
import { PARTY_TYPE_LABELS, PARTY_TYPES } from "@/lib/schemas";

export const metadata: Metadata = { title: "Clients & fournisseurs" };

const BASE = "/tiers";
const linkBtn = "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium";

export default async function ThirdPartiesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { ctx } = await requireCompanyContext();
  const base = parseListParams(params, THIRD_PARTY_SORTS, "nom");
  const role = params.role === "clients" || params.role === "fournisseurs" ? params.role : undefined;
  const type = PARTY_TYPES.find((t) => t === params.type);
  const { rows, total, pageSize } = await listThirdParties(await getDb(), ctx, { ...base, role, type });
  const canWrite = can(ctx, "thirdparties.write");
  const filtered = !!(base.q || role || type || base.archived);

  return (
    <>
      <PageHeader
        title="Clients & fournisseurs"
        description="Fiches clients et fournisseurs, coordonnées, contacts et conditions de paiement."
        actions={
          <>
            {can(ctx, "exports.run") && (
              <a href="/api/exports/tiers" className={`${linkBtn} text-foreground-muted hover:bg-muted`}>
                <Download className="size-4" aria-hidden /> Exporter
              </a>
            )}
            {canWrite && (
              <>
                <Link href="/tiers/import" className={`${linkBtn} text-foreground-muted hover:bg-muted`}>
                  <Upload className="size-4" aria-hidden /> Importer
                </Link>
                <Link href="/tiers/nouveau" className={`${linkBtn} bg-accent text-accent-foreground shadow-sm hover:bg-accent-hover`}>
                  <Plus className="size-4" aria-hidden /> Nouveau
                </Link>
              </>
            )}
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <SearchInput placeholder="Rechercher nom, code, e-mail, SIREN, ville…" />
          <FilterTabs
            base={BASE}
            params={params}
            name="role"
            value={role ?? ""}
            options={[
              { value: "", label: "Tous" },
              { value: "clients", label: "Clients" },
              { value: "fournisseurs", label: "Fournisseurs" },
            ]}
          />
          <FilterTabs
            base={BASE}
            params={params}
            name="type"
            value={type ?? ""}
            options={[{ value: "", label: "Tous types" }, ...PARTY_TYPES.map((t) => ({ value: t, label: PARTY_TYPE_LABELS[t] }))]}
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
            icon={<Users className="size-5" aria-hidden />}
            title={filtered ? "Aucun résultat" : "Aucun client ni fournisseur"}
            description={
              filtered
                ? "Modifiez la recherche ou les filtres."
                : "Créez votre première fiche, ou importez vos tiers depuis un fichier CSV."
            }
            action={
              !filtered && canWrite ? (
                <Link href="/tiers/nouveau" className={`${linkBtn} bg-accent text-accent-foreground hover:bg-accent-hover`}>
                  <Plus className="size-4" aria-hidden /> Nouveau tiers
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <SortHeader base={BASE} params={params} column="code" label="Code" activeSort={base.sort} dir={base.dir} />
                  <SortHeader base={BASE} params={params} column="nom" label="Nom" activeSort={base.sort} dir={base.dir} />
                  <th className="px-5 py-2.5 font-medium">Type</th>
                  <th className="px-5 py-2.5 font-medium">Rôle</th>
                  <th className="px-5 py-2.5 font-medium">Contact</th>
                  <th className="px-5 py-2.5 font-medium">Ville</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0 hover:bg-surface">
                    <td className="px-5 py-3 font-mono text-xs text-foreground-muted">{t.code}</td>
                    <td className="px-5 py-3">
                      <Link href={`/tiers/${t.id}`} className="font-medium text-foreground hover:text-accent">
                        {t.name}
                      </Link>
                      {t.partyType === "business" && !t.siren && t.billingCountry === "FR" && (
                        <Badge tone="warning" className="ml-2">
                          SIREN manquant
                        </Badge>
                      )}
                    </td>
                    <td className="px-5 py-3 text-foreground-muted">{PARTY_TYPE_LABELS[t.partyType]}</td>
                    <td className="px-5 py-3">
                      <div className="flex gap-1">
                        {t.isCustomer && <Badge tone="accent">Client</Badge>}
                        {t.isSupplier && <Badge>Fournisseur</Badge>}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-foreground-muted">{t.email ?? t.phone ?? "—"}</td>
                    <td className="px-5 py-3 text-foreground-muted">{t.billingCity ?? "—"}</td>
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
