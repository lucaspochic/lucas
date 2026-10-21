import type { getTicket } from "@/server/services/cash";
import { formatEuro, formatRate } from "@/server/domain/money";
import { PAYMENT_METHOD_LABELS } from "@/lib/schemas";

type TicketView = Awaited<ReturnType<typeof getTicket>>;

const qtyLabel = (q: string) => Number(q).toLocaleString("fr-FR", { maximumFractionDigits: 3 });

/** Ticket de caisse (format 80 mm), identique à l'écran et à l'impression. */
export function Receipt({ view }: { view: TicketView }) {
  const { ticket, lines, payments, register, company, vat, original } = view;
  const refund = ticket.kind === "refund";
  return (
    <div className="relative mx-auto w-full max-w-[80mm] bg-white px-4 py-5 font-mono text-[11px] leading-snug text-black">
      {ticket.training && (
        <p className="mb-3 border-2 border-black py-1 text-center text-xs font-bold">MODE ÉCOLE — TICKET SANS VALEUR</p>
      )}
      <div className="text-center">
        <p className="text-sm font-bold">{company.tradeName || company.legalName}</p>
        {company.tradeName && <p>{company.legalName}</p>}
        {company.addressLine1 && <p>{company.addressLine1}</p>}
        {company.addressLine2 && <p>{company.addressLine2}</p>}
        {(company.postalCode || company.city) && <p>{[company.postalCode, company.city].filter(Boolean).join(" ")}</p>}
        {company.siren && <p>SIREN {company.siren}</p>}
        {company.vatNumber && <p>TVA {company.vatNumber}</p>}
      </div>
      <div className="my-3 border-y border-dashed border-black py-1.5">
        <p className="flex justify-between">
          <span>{refund ? "REMBOURSEMENT" : "TICKET"} {ticket.number}</span>
          <span>Caisse {register.code}</span>
        </p>
        <p>{ticket.recordedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "medium" })}</p>
        {original && <p>Ticket d&apos;origine : {original.number}</p>}
        {ticket.reason && <p>Motif : {ticket.reason}</p>}
      </div>
      <table className="w-full">
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="align-top">
              <td className="pr-2">
                {l.label.replace(/ \[ligne \d+\]$/, "")}
                <span className="block text-[10px]">
                  {qtyLabel(l.quantity)} × {formatEuro(l.unitPriceInclTax)} · TVA {formatRate(l.vatRate)}
                </span>
              </td>
              <td className="whitespace-nowrap text-right">{formatEuro(l.totalInclTax)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 border-t border-dashed border-black pt-1.5">
        <p className="flex justify-between text-sm font-bold">
          <span>TOTAL TTC</span>
          <span>{formatEuro(ticket.totalInclTax)}</span>
        </p>
        {vat.map((v) => (
          <p key={v.vatRate} className="flex justify-between text-[10px]">
            <span>
              TVA {formatRate(v.vatRate)} · HT {formatEuro(v.exclTax)}
            </span>
            <span>{formatEuro(v.vat)}</span>
          </p>
        ))}
        <p className="flex justify-between text-[10px]">
          <span>Total HT</span>
          <span>{formatEuro(ticket.totalExclTax)}</span>
        </p>
      </div>
      <div className="mt-2 border-t border-dashed border-black pt-1.5">
        {payments.map((p) => (
          <p key={p.id} className="flex justify-between">
            <span>{PAYMENT_METHOD_LABELS[p.method]}</span>
            <span>{formatEuro(p.amount)}</span>
          </p>
        ))}
      </div>
      <p className="mt-3 break-all text-center text-[9px]">Empreinte {ticket.hash.slice(0, 16)}</p>
      <p className="mt-1 text-center">Merci de votre visite</p>
    </div>
  );
}
