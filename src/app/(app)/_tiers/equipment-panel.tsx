import Link from "next/link";
import { Plus, Tractor } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@/components/ui/card";
import { EQUIPMENT_CATEGORY_LABELS } from "@/lib/schemas";
import type { listEquipmentOfParty } from "@/server/services/equipment";
import { warrantyBadge } from "../parc/equipment-ui";

type Row = Awaited<ReturnType<typeof listEquipmentOfParty>>[number];

/** Parc du client : matériels détenus, avec accès à leur fiche. */
export function EquipmentPanel({ thirdPartyId, rows, canWrite }: { thirdPartyId: string; rows: Row[]; canWrite: boolean }) {
  const active = rows.filter((r) => !r.archivedAt);
  return (
    <Card>
      <CardHeader
        title="Parc matériel"
        description={active.length ? `${active.length} matériel(s) en service` : undefined}
        actions={
          canWrite ? (
            <Link href={`/parc/nouveau?client=${thirdPartyId}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
              <Plus className="size-4" aria-hidden /> Ajouter
            </Link>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <CardBody className="p-0">
          <EmptyState icon={<Tractor className="size-5" aria-hidden />} title="Aucun matériel" description="Les matériels vendus à ce client apparaîtront ici." />
        </CardBody>
      ) : (
        <ul className="divide-y divide-border text-[13px]">
          {rows.map((r) => (
            <li key={r.id} className={`px-5 py-2.5 ${r.archivedAt ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-2">
                <Link href={`/parc/${r.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-accent">
                  {r.brand} {r.model}
                </Link>
                {r.archivedAt ? <Badge>Archivé</Badge> : warrantyBadge(r.warrantyEndsOn)}
              </div>
              <p className="text-xs text-foreground-muted">
                {EQUIPMENT_CATEGORY_LABELS[r.category]}
                {r.year ? ` · ${r.year}` : ""}
                {r.registration ? ` · ${r.registration}` : ""}
                {r.serialNumber ? ` · ${r.serialNumber}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
