import Link from "next/link";
import { Download, Plus, Truck, Upload, Users } from "lucide-react";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/card";
import { FilterTabs, Pagination, SortHeader, type SearchParams } from "@/components/data/list-controls";
import { SearchInput } from "@/components/data/search-input";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { listThirdParties, THIRD_PARTY_SORTS } from "@/server/services/third-parties";
import { parseListParams } from "@/server/services/listing";
import { PARTY_TYPE_LABELS, PARTY_TYPES } from "@/lib/schemas";
import { hasRole, SECTION_INFO, type PartySection } from "@/lib/party-sections";

const linkBtn = "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium";

/** Liste des clients ou des fournisseurs (un tiers ayant les deux rôles figure dans les deux). */
export async function PartyListPage({ section, params }: { section: PartySection; params: SearchParams }) {
  const info = SECTION_INFO[section];
  const base = `/${section}`;
  const { ctx } = await requireCompanyContext();
  const list = parseListParams(params, THIRD_PARTY_SORTS, "nom");
  const type = PARTY_TYPES.find((t) => t === params.type);
  const { rows, total, pageSize } = await listThirdParties(await getDb(), ctx, { ...list, role: section, type });
  const canWrite = can(ctx, "thirdparties.write");
  const filtered = !!(list.q || type || list.archived);
  const Icon = section === "clients" ? Users : Truck;

  return (
    <>
      <PageHeader
        title={info.title}
        description={info.description}
        actions={
          <>
            {can(ctx, "exports.run") && (
              <a href={`/api/exports/tiers?role=${section}`} className={`${linkBtn} text-foreground-muted hover:bg-muted`}>
                <Download className="size-4" aria-hidden /> Exporter
              </a>
            )}
            {canWrite && (
              <>
                <Link href={`/tiers/import?retour=${section}`} className={`${linkBtn} text-foreground-muted hover:bg-muted`}>
                  <Upload className="size-4" aria-hidden /> Importer
                </Link>
                <Link href={`${base}/nouveau`} className={`${linkBtn} bg-accent text-accent-foreground shadow-sm hover:bg-accent-hover`}>
                  <Plus className="size-4" aria-hidden /> {info.newTitle}
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
            base={base}
            params={params}
            name="type"
            value={type ?? ""}
            options={[{ value: "", label: "Tous types" }, ...PARTY_TYPES.map((t) => ({ value: t, label: PARTY_TYPE_LABELS[t] }))]}
          />
          <FilterTabs
            base={base}
            params={params}
            name="archives"
            value={list.archived ? "1" : ""}
            options={[
              { value: "", label: "Actifs" },
              { value: "1", label: "Archivés" },
            ]}
          />
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<Icon className="size-5" aria-hidden />}
            title={filtered ? "Aucun résultat" : info.empty}
            description={
              filtered
                ? "Modifiez la recherche ou les filtres."
                : `Créez votre première fiche ${info.singular}, ou importez-les depuis un fichier CSV.`
            }
            action={
              !filtered && canWrite ? (
                <Link href={`${base}/nouveau`} className={`${linkBtn} bg-accent text-accent-foreground hover:bg-accent-hover`}>
                  <Plus className="size-4" aria-hidden /> {info.newTitle}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <SortHeader base={base} params={params} column="code" label="Code" activeSort={list.sort} dir={list.dir} />
                  <SortHeader base={base} params={params} column="nom" label="Nom" activeSort={list.sort} dir={list.dir} />
                  <th className="px-5 py-2.5 font-medium">Type</th>
                  <th className="px-5 py-2.5 font-medium">Contact</th>
                  <th className="px-5 py-2.5 font-medium">Ville</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0 hover:bg-surface">
                    <td className="px-5 py-3 font-mono text-xs text-foreground-muted">{t.code}</td>
                    <td className="px-5 py-3">
                      <Link href={`${base}/${t.id}`} className="font-medium text-foreground hover:text-accent">
                        {t.name}
                      </Link>
                      {hasRole(t, info.other) && <Badge className="ml-2">{info.otherLabel}</Badge>}
                      {t.partyType === "business" && !t.siren && t.billingCountry === "FR" && (
                        <Badge tone="warning" className="ml-2">
                          SIREN manquant
                        </Badge>
                      )}
                    </td>
                    <td className="px-5 py-3 text-foreground-muted">{PARTY_TYPE_LABELS[t.partyType]}</td>
                    <td className="px-5 py-3 text-foreground-muted">{t.email ?? t.phone ?? "—"}</td>
                    <td className="px-5 py-3 text-foreground-muted">{t.billingCity ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination base={base} params={params} page={list.page} total={total} pageSize={pageSize} />
      </Card>
    </>
  );
}
