import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { orNotFound, requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { listVatRates } from "@/server/services/companies";
import {
  getSalesDocument,
  listCustomerOptions,
  listProductOptions,
  verifyDocumentIntegrity,
} from "@/server/services/sales";
import { DOCUMENT_TYPE_LABELS } from "@/server/domain/sales";
import { formatEuro } from "@/server/domain/money";
import { formatDateTime } from "@/lib/utils";
import { SalesEditor } from "../sales-editor";
import { DocumentView } from "../document-view";
import { StatusBadge } from "../sales-ui";
import { DraftActions, IssuedActions } from "./document-actions";

export const metadata: Metadata = { title: "Document de vente" };

/** « 12.5000 » → « 12,5 » pour l'édition. */
const editable = (v: string) => {
  const [i, f = ""] = v.split(".");
  const t = f.replace(/0+$/, "");
  return t ? `${i},${t}` : i!;
};

export default async function SalesDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireCompanyContext();
  const db = await getDb();
  const data = await orNotFound(getSalesDocument(db, ctx, id));
  const { doc, lines, vat, source, derived } = data;
  const label = DOCUMENT_TYPE_LABELS[doc.type];
  const isDraft = doc.status === "draft";

  const back = (
    <Link
      href={`/ventes?type=${doc.type === "quote" ? "devis" : doc.type === "credit_note" ? "avoirs" : "factures"}`}
      className="mb-3 inline-flex items-center gap-1 text-[13px] text-foreground-muted hover:text-foreground"
    >
      <ChevronLeft className="size-4" aria-hidden /> Devis & factures
    </Link>
  );

  const related = (
    <>
      {source && (
        <p className="text-[13px] text-foreground-muted">
          Établi à partir de {DOCUMENT_TYPE_LABELS[source.type].toLowerCase()}{" "}
          <Link href={`/ventes/${source.id}`} className="font-medium text-accent hover:underline">
            {source.number}
          </Link>
        </p>
      )}
      {derived.map((d) => (
        <p key={d.id} className="text-[13px] text-foreground-muted">
          {DOCUMENT_TYPE_LABELS[d.type]}{" "}
          <Link href={`/ventes/${d.id}`} className="font-medium text-accent hover:underline">
            {d.number ?? "brouillon"}
          </Link>{" "}
          — {formatEuro(d.totalInclTax)}
        </p>
      ))}
    </>
  );

  if (isDraft) {
    const [customers, productOptions, rates] = await Promise.all([
      listCustomerOptions(db, ctx),
      listProductOptions(db, ctx),
      listVatRates(db, ctx),
    ]);
    // Le client courant reste proposé même s'il a été archivé depuis.
    if (!customers.some((c) => c.id === data.party.id)) customers.unshift(data.party);
    const rateIdOf = (rate: string, reason: string | null) =>
      rates.find((r) => r.rate === rate && (r.exemptionReason ?? null) === (reason ?? null))?.id ?? "";

    return (
      <>
        {back}
        <PageHeader
          title={`${label} — brouillon`}
          description={`Créé le ${formatDateTime(doc.createdAt)}. Aucun numéro n'est attribué avant l'émission.`}
          actions={<DraftActions id={doc.id} type={doc.type} canIssue={can(ctx, "sales.issue")} canWrite={can(ctx, "sales.write")} />}
        />
        <div className="mb-4 space-y-1">{related}</div>
        {can(ctx, "sales.write") ? (
          <SalesEditor
            documentId={doc.id}
            type={doc.type}
            customerLocked={doc.type === "credit_note"}
            customers={customers}
            productOptions={productOptions}
            rates={rates.map((r) => ({ id: r.id, label: r.label, rate: r.rate, exemptionReason: r.exemptionReason, active: r.active }))}
            defaults={{
              thirdPartyId: doc.thirdPartyId,
              deliveryDate: doc.deliveryDate ?? "",
              globalDiscountPercent: editable(doc.globalDiscountPercent),
              notes: doc.notes ?? "",
              lines: lines.map((l) => ({
                productId: l.productId,
                reference: l.reference ?? "",
                description: l.description,
                kind: l.kind,
                quantity: editable(l.quantity),
                unit: l.unit as "unité",
                unitPriceExclTax: editable(l.unitPriceExclTax),
                discountPercent: editable(l.discountPercent),
                vatRateId: rateIdOf(l.vatRate, l.vatExemptionReason),
              })),
            }}
          />
        ) : (
          <Card>
            <CardBody className="text-[13px] text-foreground-muted">Brouillon en cours de rédaction — total {formatEuro(doc.totalInclTax)}.</CardBody>
          </Card>
        )}
      </>
    );
  }

  const integrity = await verifyDocumentIntegrity(db, ctx, doc.id);
  return (
    <>
      {back}
      <PageHeader
        title={`${label} ${doc.number}`}
        description={`Émis le ${formatDateTime(doc.issuedAt!)} — ${data.party.name}`}
        actions={
          <IssuedActions
            id={doc.id}
            type={doc.type}
            status={doc.status}
            canWrite={can(ctx, "sales.write")}
            hasInvoice={derived.some((d) => d.type === "invoice")}
          />
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_280px]">
        <div className="overflow-x-auto rounded-lg border border-border shadow-card">
          <DocumentView doc={doc} lines={lines} vat={vat} sourceNumber={source?.number ?? null} />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Suivi" />
            <CardBody className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="text-foreground-muted">Statut</span>
                <StatusBadge status={doc.status} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-foreground-muted">Total TTC</span>
                <span className="tabular font-medium">{formatEuro(doc.totalInclTax)}</span>
              </div>
              {doc.type === "invoice" && (
                <div className="flex items-center justify-between">
                  <span className="text-foreground-muted">Réglé</span>
                  <span className="tabular">{formatEuro(doc.amountPaid)}</span>
                </div>
              )}
              <div className="space-y-1 pt-1">{related}</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-start gap-2 text-[13px]">
              {integrity.valid ? (
                <>
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  <span>Intégrité vérifiée : le contenu correspond à l&apos;empreinte enregistrée à l&apos;émission.</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                  <span className="text-danger">
                    Alerte : le contenu ne correspond plus à l&apos;empreinte d&apos;émission. Le document a été altéré en dehors de
                    l&apos;application.
                  </span>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
