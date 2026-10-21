import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Wallet } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { FilterTabs, Pagination, SortHeader, type SearchParams } from "@/components/data/list-controls";
import { SearchInput } from "@/components/data/search-input";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { listPayments, PAYMENT_SORTS } from "@/server/services/payments";
import { parseListParams } from "@/server/services/listing";
import { formatEuro } from "@/server/domain/money";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@/lib/schemas";
import { formatDate } from "../ventes/sales-ui";
import { KindBadge } from "./payment-ui";

export const metadata: Metadata = { title: "Règlements" };

const BASE = "/reglements";
const KINDS = ["receipt", "refund", "reversal"] as const;

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { ctx } = await requireCompanyContext();
  const base = parseListParams(params, PAYMENT_SORTS, "date");
  const dir = params.ordre ? base.dir : "desc";
  const method = PAYMENT_METHODS.find((m) => m === params.mode);
  const kind = KINDS.find((k) => k === params.nature);
  const { rows, total, pageSize } = await listPayments(await getDb(), ctx, { ...base, dir, method, kind });

  return (
    <>
      <PageHeader
        title="Règlements"
        description="Encaissements, remboursements et contre-passations. Un règlement enregistré n'est jamais modifié : une erreur se corrige par contre-passation."
        actions={
          can(ctx, "payments.write") && (
            <Link
              href="/reglements/nouveau"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-sm hover:bg-accent-hover"
            >
              <Plus className="size-4" aria-hidden /> Encaissement
            </Link>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <SearchInput placeholder="Rechercher n°, référence, client…" />
          <FilterTabs
            base={BASE}
            params={params}
            name="nature"
            value={kind ?? ""}
            options={[
              { value: "", label: "Tous" },
              { value: "receipt", label: "Encaissements" },
              { value: "refund", label: "Remboursements" },
              { value: "reversal", label: "Contre-passations" },
            ]}
          />
          <FilterTabs
            base={BASE}
            params={params}
            name="mode"
            value={method ?? ""}
            options={[{ value: "", label: "Tous modes" }, ...PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))]}
          />
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={<Wallet className="size-5" aria-hidden />}
            title="Aucun règlement"
            description="Enregistrez les paiements reçus : ils sont imputés sur les factures et mettent à jour leur statut."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <SortHeader base={BASE} params={params} column="numero" label="N°" activeSort={base.sort} dir={dir} />
                  <SortHeader base={BASE} params={params} column="date" label="Enregistré" activeSort={base.sort} dir={dir} />
                  <th className="px-5 py-2.5 font-medium">Date de paiement</th>
                  <th className="px-5 py-2.5 font-medium">Client</th>
                  <th className="px-5 py-2.5 font-medium">Nature</th>
                  <th className="px-5 py-2.5 font-medium">Mode</th>
                  <SortHeader base={BASE} params={params} column="montant" label="Montant" activeSort={base.sort} dir={dir} className="text-right" />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0 hover:bg-surface">
                    <td className="px-5 py-3">
                      <Link href={`/reglements/${p.id}`} className="font-mono text-xs font-medium hover:text-accent">
                        {p.number}
                      </Link>
                    </td>
                    <td className="tabular whitespace-nowrap px-5 py-3 text-foreground-muted">
                      {new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(p.recordedAt)}
                    </td>
                    <td className="tabular px-5 py-3 text-foreground-muted">{formatDate(p.paymentDate)}</td>
                    <td className="px-5 py-3">{p.partyName}</td>
                    <td className="px-5 py-3">
                      <KindBadge kind={p.kind} />
                    </td>
                    <td className="px-5 py-3 text-foreground-muted">{PAYMENT_METHOD_LABELS[p.method]}</td>
                    <td className={`tabular whitespace-nowrap px-5 py-3 text-right font-medium ${p.amount.startsWith("-") ? "text-danger" : ""}`}>
                      {formatEuro(p.amount)}
                    </td>
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
