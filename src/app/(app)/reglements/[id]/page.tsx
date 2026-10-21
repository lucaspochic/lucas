import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ShieldCheck } from "lucide-react";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { orNotFound, requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { getPayment } from "@/server/services/payments";
import { dec, formatEuro } from "@/server/domain/money";
import { PAYMENT_METHOD_LABELS } from "@/lib/schemas";
import { formatDateTime } from "@/lib/utils";
import { PARTY_TYPE_LABELS } from "@/lib/schemas";
import { formatDate } from "../../ventes/sales-ui";
import { KindBadge, PAYMENT_KIND_LABELS } from "../payment-ui";
import { ReverseButton } from "./reverse-button";

export const metadata: Metadata = { title: "Règlement" };

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireCompanyContext();
  const { payment: p, partyName, partyCode, allocations, reversedBy, reverses } = await orNotFound(getPayment(await getDb(), ctx, id));
  const allocated = allocations.reduce((acc, a) => acc.plus(a.amount), dec("0"));
  const unallocated = dec(p.amount).minus(allocated);

  const row = (label: React.ReactNode, value: React.ReactNode, key?: string) => (
    <div key={key} className="flex justify-between gap-4 py-1.5">
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );

  return (
    <>
      <Link href="/reglements" className="mb-3 inline-flex items-center gap-1 text-[13px] text-foreground-muted hover:text-foreground">
        <ChevronLeft className="size-4" aria-hidden /> Règlements
      </Link>
      <PageHeader
        title={`${PAYMENT_KIND_LABELS[p.kind]} ${p.number}`}
        description={`Enregistré le ${formatDateTime(p.recordedAt)}`}
        actions={can(ctx, "payments.write") && p.kind !== "reversal" && !reversedBy ? <ReverseButton id={p.id} number={p.number} /> : undefined}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Détail" actions={<KindBadge kind={p.kind} />} />
          <CardBody>
            <dl className="divide-y divide-border text-[13px]">
              {row("Montant", <span className="tabular text-base font-semibold">{formatEuro(p.amount)}</span>)}
              {row("Client", <Link href={`/tiers/${p.thirdPartyId}`} className="text-accent hover:underline">{`${partyName} (${partyCode})`}</Link>)}
              {row("Type de client", PARTY_TYPE_LABELS[p.partyTypeSnapshot])}
              {row("Date du paiement", formatDate(p.paymentDate))}
              {row("Mode", PAYMENT_METHOD_LABELS[p.method])}
              {p.reference && row("Référence", p.reference)}
              {p.reason && row("Motif", p.reason)}
              {reverses && row("Contre-passe", <Link href={`/reglements/${reverses.id}`} className="text-accent hover:underline">{reverses.number}</Link>)}
              {reversedBy &&
                row(
                  "Contre-passé par",
                  <Link href={`/reglements/${reversedBy.id}`} className="font-medium text-danger hover:underline">
                    {reversedBy.number}
                  </Link>,
                )}
            </dl>
          </CardBody>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Imputation" />
            <CardBody>
              {allocations.length === 0 ? (
                <p className="text-[13px] text-foreground-muted">Non imputé sur une facture.</p>
              ) : (
                <dl className="divide-y divide-border text-[13px]">
                  {allocations.map((a) =>
                    row(
                      <Link href={`/ventes/${a.documentId}`} className="font-mono text-xs text-accent hover:underline">
                        {a.number}
                      </Link>,
                      <span className="tabular">{formatEuro(a.amount)}</span>,
                      a.documentId,
                    ),
                  )}
                </dl>
              )}
              {!unallocated.isZero() && (
                <p className="mt-2 text-[13px] text-foreground-muted">
                  Non imputé : <span className="tabular font-medium text-foreground">{formatEuro(unallocated)}</span>
                </p>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-start gap-2 text-[13px] text-foreground-muted">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <span>
                Enregistrement inaltérable, chaîné au précédent (n° {p.chainSeq}). Empreinte :{" "}
                <span className="break-all font-mono text-[11px]">{p.hash}</span>
              </span>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
