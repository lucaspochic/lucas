import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { AttachmentsPanel } from "@/components/attachments/attachments-panel";
import { getDb } from "@/server/db/client";
import { orNotFound, requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { customerOptions, equipmentHistory, getEquipment, invoicesOfParty } from "@/server/services/equipment";
import { EQUIPMENT_CATEGORY_LABELS } from "@/lib/schemas";
import { formatDateTime } from "@/lib/utils";
import { formatDate } from "../../ventes/sales-ui";
import { EquipmentForm } from "../equipment-form";
import { warrantyBadge } from "../equipment-ui";
import { ArchiveEquipmentButton } from "./archive-equipment-button";

export const metadata: Metadata = { title: "Matériel" };

const ACTION_LABELS: Record<string, string> = {
  "equipment.created": "Ajout au parc",
  "equipment.updated": "Modification",
  "equipment.owner_changed": "Changement de propriétaire",
  "equipment.archived": "Archivage",
  "equipment.restored": "Restauration",
};

function historyDetail(action: string, payload: unknown): string | null {
  const p = (payload ?? {}) as { owner?: { name?: string }; from?: { name?: string } | null; to?: { name?: string }; changes?: Record<string, unknown> };
  if (action === "equipment.created") return p.owner?.name ? `Client : ${p.owner.name}` : null;
  if (action === "equipment.owner_changed") return `${p.from?.name ?? "?"} → ${p.to?.name ?? "?"}`;
  if (action === "equipment.updated" && p.changes) return `${Object.keys(p.changes).length} champ(s) modifié(s)`;
  return null;
}

export default async function EquipmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const created = (await searchParams).cree === "1";
  const { ctx } = await requireCompanyContext();
  const db = await getDb();
  const { item, partyName, partyCode, invoiceNumber, invoiceDate } = await orNotFound(getEquipment(db, ctx, id));
  const [customers, invoices, history] = await Promise.all([
    customerOptions(db, ctx, item.thirdPartyId),
    invoicesOfParty(db, ctx, item.thirdPartyId),
    equipmentHistory(db, ctx, id),
  ]);
  const canWrite = can(ctx, "thirdparties.write");
  const archived = !!item.archivedAt;
  const name = `${item.brand} ${item.model}`;

  return (
    <>
      <Link href="/parc" className="mb-3 inline-flex items-center gap-1 text-[13px] text-foreground-muted hover:text-foreground">
        <ChevronLeft className="size-4" aria-hidden /> Parc matériel
      </Link>
      <PageHeader
        title={name}
        description={`${EQUIPMENT_CATEGORY_LABELS[item.category]}${item.year ? ` · ${item.year}` : ""} · ajouté le ${formatDateTime(item.createdAt)}`}
        actions={
          <>
            {archived && <Badge tone="warning">Archivé</Badge>}
            {canWrite && <ArchiveEquipmentButton id={item.id} archived={archived} name={name} />}
          </>
        }
      />
      {created && <p className="mb-4 rounded-md bg-success-soft px-3 py-2 text-[13px] text-success">Matériel ajouté au parc de {partyName}.</p>}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <EquipmentForm
            id={item.id}
            readOnly={!canWrite || archived}
            customers={customers}
            initialInvoices={invoices.map((i) => ({ id: i.id, number: i.number, issueDate: i.issueDate }))}
            defaults={{
              thirdPartyId: item.thirdPartyId,
              category: item.category,
              brand: item.brand,
              model: item.model,
              serialNumber: item.serialNumber ?? "",
              registration: item.registration ?? "",
              year: item.year ?? "",
              meterValue: item.meterValue ?? "",
              meterUnit: item.meterUnit ?? "",
              salesDocumentId: item.salesDocumentId ?? "",
              soldOn: item.soldOn ?? "",
              warrantyEndsOn: item.warrantyEndsOn ?? "",
              notes: item.notes ?? "",
            }}
          />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="En bref" />
            <CardBody className="space-y-2 text-[13px]">
              <p>
                <span className="text-foreground-muted">Propriétaire : </span>
                <Link href={`/tiers/${item.thirdPartyId}`} className="font-medium hover:text-accent">
                  {partyName}
                </Link>{" "}
                <span className="text-foreground-subtle">({partyCode})</span>
              </p>
              {invoiceNumber && item.salesDocumentId && (
                <p>
                  <span className="text-foreground-muted">Vendu par : </span>
                  <Link href={`/ventes/${item.salesDocumentId}`} className="font-medium hover:text-accent">
                    facture {invoiceNumber}
                  </Link>
                  {invoiceDate && <span className="text-foreground-subtle"> du {formatDate(invoiceDate)}</span>}
                </p>
              )}
              {item.warrantyEndsOn && (
                <p className="flex items-center gap-2">
                  <span className="text-foreground-muted">Garantie :</span> {warrantyBadge(item.warrantyEndsOn)}
                </p>
              )}
            </CardBody>
          </Card>
          <AttachmentsPanel ctx={ctx} entityType="equipment" entityId={item.id} path={`/parc/${item.id}`} />
          <Card>
            <CardHeader title="Historique" description="Propriétaires successifs et modifications, d'après le journal d'audit." />
            <ul className="divide-y divide-border text-[13px]">
              {history.map((h, i) => (
                <li key={i} className="px-5 py-2.5">
                  <p className="font-medium">{ACTION_LABELS[h.action] ?? h.action}</p>
                  <p className="text-xs text-foreground-muted">
                    {formatDateTime(h.occurredAt)}
                    {h.actor ? ` · ${h.actor}` : ""}
                  </p>
                  {historyDetail(h.action, h.payload) && <p className="text-xs text-foreground-subtle">{historyDetail(h.action, h.payload)}</p>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
