import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, ChevronLeft, FileText } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { orNotFound, requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { getCompany } from "@/server/services/companies";
import { getThirdParty, listContacts } from "@/server/services/third-parties";
import { PARTY_TYPE_LABELS } from "@/lib/schemas";
import { hasRole, partyHref, SECTION_INFO, type PartySection } from "@/lib/party-sections";
import { formatDateTime } from "@/lib/utils";
import { ThirdPartyForm } from "./third-party-form";
import { ArchiveThirdPartyButton, ContactsPanel } from "./third-party-client";
import { AttachmentsPanel } from "@/components/attachments/attachments-panel";
import { listEquipmentOfParty } from "@/server/services/equipment";
import { EquipmentPanel } from "./equipment-panel";

/** Fiche d'un tiers, vue depuis la rubrique Clients ou Fournisseurs. */
export async function PartyDetailPage({ section, id, created }: { section: PartySection; id: string; created: boolean }) {
  const { ctx } = await requireCompanyContext();
  const db = await getDb();
  const [party, contacts, company, parc] = await Promise.all([
    orNotFound(getThirdParty(db, ctx, id)),
    listContacts(db, ctx, id),
    getCompany(db, ctx),
    listEquipmentOfParty(db, ctx, id),
  ]);
  // Un fournisseur ouvert depuis /clients (ou l'inverse, ou après un changement de rôle) : bonne rubrique.
  if (!hasRole(party, section)) redirect(`${partyHref(party)}${created ? "?cree=1" : ""}`);

  const info = SECTION_INFO[section];
  const path = `/${section}/${party.id}`;
  const canWrite = can(ctx, "thirdparties.write");
  const archived = !!party.archivedAt;
  // Parc affiché côté client si le module est actif, ou si le client détient déjà des matériels.
  const showParc = section === "clients" && (company.modules.includes("parc") || parc.length > 0);
  const alsoOther = hasRole(party, info.other);

  return (
    <>
      <Link href={`/${section}`} className="mb-3 inline-flex items-center gap-1 text-[13px] text-foreground-muted hover:text-foreground">
        <ChevronLeft className="size-4" aria-hidden /> {info.title}
      </Link>
      <PageHeader
        title={party.name}
        description={`${party.code} · ${PARTY_TYPE_LABELS[party.partyType]} · créé le ${formatDateTime(party.createdAt)}`}
        actions={
          <>
            {alsoOther && (
              <Link
                href={`/${info.other}/${party.id}`}
                className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-foreground-muted hover:bg-muted"
              >
                {info.otherLabel} <ArrowRight className="size-4" aria-hidden />
              </Link>
            )}
            {archived && <Badge tone="warning">Archivé</Badge>}
            {canWrite && <ArchiveThirdPartyButton id={party.id} archived={archived} name={party.name} />}
          </>
        }
      />
      {created && (
        <p className="mb-4 rounded-md bg-success-soft px-3 py-2 text-[13px] text-success">Fiche créée avec le code {party.code}.</p>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ThirdPartyForm
            id={party.id}
            section={section}
            readOnly={!canWrite || archived}
            defaultTermsDays={company.paymentTermsDays}
            defaults={{
              code: party.code,
              partyType: party.partyType,
              isCustomer: party.isCustomer,
              isSupplier: party.isSupplier,
              name: party.name,
              legalForm: party.legalForm ?? "",
              siren: party.siren ?? "",
              siret: party.siret ?? "",
              vatNumber: party.vatNumber ?? "",
              email: party.email ?? "",
              phone: party.phone ?? "",
              billingLine1: party.billingLine1 ?? "",
              billingLine2: party.billingLine2 ?? "",
              billingPostalCode: party.billingPostalCode ?? "",
              billingCity: party.billingCity ?? "",
              billingCountry: party.billingCountry,
              hasShippingAddress: !!party.shippingLine1,
              shippingLine1: party.shippingLine1 ?? "",
              shippingLine2: party.shippingLine2 ?? "",
              shippingPostalCode: party.shippingPostalCode ?? "",
              shippingCity: party.shippingCity ?? "",
              shippingCountry: party.shippingCountry ?? "",
              paymentTermsDays: party.paymentTermsDays === null ? "" : party.paymentTermsDays,
              notes: party.notes ?? "",
            }}
          />
        </div>

        <div className="space-y-6">
          <ContactsPanel
            thirdPartyId={party.id}
            canWrite={canWrite && !archived}
            contacts={contacts.map((c) => ({
              id: c.id,
              fullName: c.fullName,
              jobTitle: c.jobTitle,
              email: c.email,
              phone: c.phone,
              isPrimary: c.isPrimary,
            }))}
          />
          <Card>
            <CardHeader title="Historique et solde" description="Devis, factures, règlements, encours et retards." />
            <CardBody className="p-0">
              <EmptyState
                icon={<FileText className="size-5" aria-hidden />}
                title="Pas encore de document"
                description="L'historique et le solde apparaîtront avec le module de facturation."
              />
            </CardBody>
          </Card>
          {showParc && <EquipmentPanel thirdPartyId={party.id} rows={parc} canWrite={canWrite && !archived} />}
          <AttachmentsPanel ctx={ctx} entityType="third_party" entityId={party.id} path={path} />
        </div>
      </div>
    </>
  );
}
