import type { Metadata } from "next";
import Link from "next/link";
import { Printer } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { orNotFound, requirePermission } from "@/server/http/session";
import { getTicket } from "@/server/services/cash";
import { dec, formatEuro } from "@/server/domain/money";
import { Receipt } from "../../receipt";
import { RefundForm } from "../../cash-client";

export const metadata: Metadata = { title: "Ticket de caisse" };
export const dynamic = "force-dynamic";

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requirePermission("cash.operate");
  const view = await orNotFound(getTicket(await getDb(), ctx, id));
  const { ticket, register, refunds, original, refundable } = view;
  const canRefund = ticket.kind === "sale" && refundable.some((l) => dec(l.remaining).greaterThan(0));

  return (
    <>
      <PageHeader
        title={`${ticket.kind === "refund" ? "Remboursement" : "Ticket"} ${ticket.number}`}
        description={`Caisse ${register.code} — ${register.name}`}
        actions={
          <>
            <Link href={`/caisse/${register.id}`} className="text-[13px] text-foreground-muted hover:text-foreground">
              Retour à la caisse
            </Link>
            <Link
              href={`/impression/caisse/${ticket.id}`}
              target="_blank"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[13px] hover:bg-muted"
            >
              <Printer className="size-3.5" aria-hidden /> Imprimer
            </Link>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-muted p-4">
          <Receipt view={view} />
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Traçabilité" />
            <CardBody className="space-y-2 text-[13px]">
              {ticket.training && <Badge tone="accent">Mode école : exclu des totaux et de la comptabilité</Badge>}
              {original && (
                <p>
                  Remboursement du ticket{" "}
                  <Link href={`/caisse/tickets/${original.id}`} className="font-medium text-accent hover:underline">
                    {original.number}
                  </Link>
                  .
                </p>
              )}
              {refunds.length > 0 && (
                <div>
                  <p className="text-foreground-muted">Remboursements liés :</p>
                  <ul>
                    {refunds.map((r) => (
                      <li key={r.id}>
                        <Link href={`/caisse/tickets/${r.id}`} className="font-medium text-accent hover:underline">
                          {r.number}
                        </Link>{" "}
                        ({formatEuro(r.total)})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="break-all text-xs text-foreground-muted">
                Rang {ticket.seq} · empreinte {ticket.hash}
                <br />
                précédente {ticket.prevHash}
              </p>
            </CardBody>
          </Card>
          {canRefund && (
            <Card>
              <CardHeader title="Rembourser" description="Crée un ticket de remboursement lié ; le ticket d'origine reste inchangé. Une session doit être ouverte." />
              <CardBody>
                <RefundForm ticketId={ticket.id} lines={refundable} />
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
