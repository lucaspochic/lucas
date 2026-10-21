import type { Metadata } from "next";
import Link from "next/link";
import { ScrollText } from "lucide-react";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { listAuditEvents } from "@/server/services/audit";
import { can } from "@/server/security/permissions";
import { formatDateTime } from "@/lib/utils";
import { VerifyChainButton } from "./verify-chain-button";

export const metadata: Metadata = { title: "Journal d'audit" };

const PAGE_SIZE = 50;

const ACTION_LABELS: Record<string, string> = {
  "company.created": "Création de l'entreprise",
  "company.updated": "Modification des paramètres",
  "member.added": "Ajout d'un membre",
  "member.role_changed": "Changement de rôle",
  "third_party.created": "Création d'un tiers",
  "third_party.updated": "Modification d'un tiers",
  "third_party.archived": "Archivage d'un tiers",
  "third_party.restored": "Restauration d'un tiers",
  "contact.added": "Ajout d'un contact",
  "contact.removed": "Suppression d'un contact",
  "product.created": "Création d'un article",
  "product.updated": "Modification d'un article",
  "product.archived": "Archivage d'un article",
  "product.restored": "Restauration d'un article",
  "sales_document.draft_created": "Création d'un brouillon",
  "sales_document.draft_updated": "Modification d'un brouillon",
  "sales_document.draft_deleted": "Suppression d'un brouillon",
  "sales_document.issued": "Émission d'un document",
  "sales_document.quote_accepted": "Devis accepté",
  "sales_document.quote_refused": "Devis refusé",
  "sales_document.invoice_from_quote": "Facture créée depuis un devis",
  "sales_document.credit_note_drafted": "Brouillon d'avoir",
  "payment.recorded": "Encaissement",
  "payment.refunded": "Remboursement",
  "payment.reversed": "Contre-passation d'un règlement",
  "expense.draft_created": "Création d'une dépense",
  "expense.draft_updated": "Modification d'une dépense",
  "expense.draft_deleted": "Suppression d'un brouillon de dépense",
  "expense.validated": "Validation d'une dépense",
  "expense.paid": "Paiement fournisseur",
  "expense.payment_reversed": "Contre-passation d'un paiement fournisseur",
  "bank_account.created": "Création d'un compte de trésorerie",
  "bank_account.default_set": "Compte de trésorerie par défaut",
  "bank_statement.imported": "Import de relevé bancaire",
  "bank_transaction.reconciled": "Rapprochement bancaire",
  "bank_transaction.unreconciled": "Annulation de rapprochement",
  "accounting.fec_exported": "Export du FEC",
  "accounting.lettered": "Lettrage",
  "accounting.unlettered": "Délettrage",
  "accounting.auto_lettered": "Lettrage automatique",
  "accounting.manual_entry": "Saisie d'une écriture",
  "accounting.fiscal_year_closed": "Clôture d'exercice",
  "cash_register.created": "Création d'une caisse",
  "cash_session.opened": "Ouverture de caisse",
  "cash_session.closed": "Fermeture de caisse",
  "cash_ticket.refunded": "Remboursement en caisse",
  "cash_closure.created": "Clôture de caisse",
  "cash_archive.created": "Archivage de caisse",
};

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx } = await requireCompanyContext();
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const events = await listAuditEvents(await getDb(), ctx, { limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
  const hasNext = events.length > PAGE_SIZE;

  return (
    <>
      <PageHeader
        title="Journal d'audit"
        description="Historique inaltérable des opérations sensibles. Chaque événement est chaîné au précédent par une empreinte SHA-256."
        actions={can(ctx, "audit.verify") ? <VerifyChainButton /> : undefined}
      />
      <Card>
        <CardHeader title="Événements" description="Du plus récent au plus ancien." />
        {events.length === 0 ? (
          <EmptyState icon={<ScrollText className="size-5" />} title="Aucun événement" description="Les opérations sensibles apparaîtront ici." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <th className="px-5 py-2.5 font-medium">N°</th>
                  <th className="px-5 py-2.5 font-medium">Date</th>
                  <th className="px-5 py-2.5 font-medium">Opération</th>
                  <th className="px-5 py-2.5 font-medium">Auteur</th>
                  <th className="px-5 py-2.5 font-medium">Détail</th>
                  <th className="px-5 py-2.5 font-medium">Empreinte</th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, PAGE_SIZE).map((ev) => (
                  <tr key={ev.id} className="border-b border-border align-top last:border-0">
                    <td className="tabular px-5 py-3 text-foreground-muted">{ev.chainSeq}</td>
                    <td className="tabular whitespace-nowrap px-5 py-3">{formatDateTime(ev.occurredAt)}</td>
                    <td className="min-w-40 px-5 py-3 font-medium">{ACTION_LABELS[ev.action] ?? ev.action}</td>
                    <td className="px-5 py-3 text-foreground-muted">{ev.actorName ?? "—"}</td>
                    <td className="min-w-72 max-w-md px-5 py-3">
                      <AuditDetail payload={ev.payload} />
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-foreground-subtle" title={ev.hash}>
                      {ev.hash.slice(0, 12)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(page > 1 || hasNext) && (
          <div className="flex justify-between border-t border-border px-5 py-3 text-[13px]">
            {page > 1 ? <Link href={`/journal?page=${page - 1}`} className="text-accent hover:underline">← Plus récents</Link> : <span />}
            {hasNext && <Link href={`/journal?page=${page + 1}`} className="text-accent hover:underline">Plus anciens →</Link>}
          </div>
        )}
      </Card>
    </>
  );
}

const FIELD_LABELS: Record<string, string> = {
  legalName: "Raison sociale",
  tradeName: "Nom commercial",
  legalForm: "Forme juridique",
  siren: "SIREN",
  siret: "SIRET",
  vatNumber: "N° TVA",
  nafCode: "Code NAF",
  shareCapital: "Capital",
  rcsCity: "RCS",
  addressLine1: "Adresse",
  addressLine2: "Complément d'adresse",
  postalCode: "Code postal",
  city: "Ville",
  country: "Pays",
  email: "E-mail",
  phone: "Téléphone",
  website: "Site web",
  iban: "IBAN",
  bic: "BIC",
  fiscalYearStartMonth: "Début d'exercice (mois)",
  vatRegime: "Régime de TVA",
  vatOnDebits: "TVA sur les débits",
  paymentTermsDays: "Délai de paiement",
  latePenaltyText: "Pénalités de retard",
  legalMentions: "Mentions complémentaires",
  invoicePrefix: "Préfixe factures",
  creditNotePrefix: "Préfixe avoirs",
  quotePrefix: "Préfixe devis",
  role: "Rôle",
  code: "Code",
  name: "Nom",
  partyType: "Type",
  isCustomer: "Client",
  isSupplier: "Fournisseur",
  billingLine1: "Adresse",
  billingPostalCode: "Code postal",
  billingCity: "Ville",
  shippingLine1: "Livraison",
  shippingCity: "Ville de livraison",
  reference: "Référence",
  unitPriceExclTax: "Prix HT",
  purchasePriceExclTax: "Prix d'achat HT",
  vatRateId: "Taux de TVA",
  kind: "Nature",
  unit: "Unité",
  category: "Catégorie",
  barcode: "Code-barres",
  fullName: "Nom",
  source: "Origine",
  number: "Numéro",
  issueDate: "Date",
  customer: "Client",
  totalExclTax: "HT",
  totalVat: "TVA",
  totalInclTax: "TTC",
  sourceNumber: "Origine",
  contentHash: "Empreinte",
  type: "Type",
  amount: "Montant",
  method: "Mode",
  hash: "Empreinte",
  reverses: "Contre-passe",
  reason: "Motif",
  from: "Avant",
  to: "Après",
};

const shorten = (v: string | null) => (v === null ? "∅" : v.length > 60 ? `${v.slice(0, 60)}…` : v);

function AuditDetail({ payload }: { payload: unknown }) {
  const p = payload as { changes?: Record<string, { from: string | null; to: string | null }> } & Record<string, unknown>;
  if (p?.changes) {
    return (
      <ul className="space-y-0.5 text-xs text-foreground-muted">
        {Object.entries(p.changes).map(([field, c]) => (
          <li key={field} title={`${c.from ?? "∅"} → ${c.to ?? "∅"}`}>
            <span className="font-medium text-foreground">{FIELD_LABELS[field] ?? field}</span> : {shorten(c.from)} →{" "}
            {shorten(c.to)}
          </li>
        ))}
      </ul>
    );
  }
  const entries = Object.entries(p ?? {});
  if (entries.length === 0) return <span className="text-foreground-subtle">—</span>;
  return (
    <span className="text-xs text-foreground-muted">
      {entries.map(([k, v]) => `${FIELD_LABELS[k] ?? k} : ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ")}
    </span>
  );
}
