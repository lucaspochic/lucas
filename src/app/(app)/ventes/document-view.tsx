import type { SalesDocument, SalesDocumentLine } from "@/server/db/schema";
import type { CustomerSnapshot, SellerSnapshot } from "@/server/domain/sales";
import { DOCUMENT_TYPE_LABELS } from "@/server/domain/sales";
import { formatEuro, formatRate, formatUnitPrice } from "@/server/domain/money";
import { dec } from "@/server/domain/money";
import { formatDate } from "./sales-ui";

interface VatRow {
  vatRate: string;
  vatExemptionReason: string | null;
  baseExclTax: string;
  vatAmount: string;
}

const CATEGORY = { goods: "Livraison de biens", services: "Prestation de services", mixed: "Livraison de biens et prestation de services" };

/**
 * Rendu d'un document émis à partir des copies figées à l'émission (vendeur, client).
 * Mentions : CGI ann. II art. 242 nonies A ; C. com. L. 441-9 ; réforme e-facture.
 */
export function DocumentView({
  doc,
  lines,
  vat,
  sourceNumber,
}: {
  doc: SalesDocument;
  lines: SalesDocumentLine[];
  vat: VatRow[];
  sourceNumber: string | null;
}) {
  const seller = doc.sellerSnapshot as SellerSnapshot;
  const customer = doc.customerSnapshot as CustomerSnapshot;
  const linesTotal = lines.reduce((acc, l) => acc.plus(l.totalExclTax), dec("0"));
  const globalDiscount = linesTotal.minus(doc.totalExclTax);
  const exemptions = [...new Set(vat.map((v) => v.vatExemptionReason).filter(Boolean))];
  const isQuote = doc.type === "quote";
  const professionalCustomer = customer.partyType !== "individual";

  return (
    <article className="document-sheet mx-auto max-w-[210mm] bg-white p-8 text-[12px] leading-relaxed text-[#1f2430] sm:p-10">
      <header className="flex flex-wrap justify-between gap-6 border-b border-[#e4e7ec] pb-6">
        <div>
          <p className="text-base font-semibold">{seller.tradeName || seller.legalName}</p>
          {seller.tradeName && <p>{seller.legalName}</p>}
          {seller.address.map((l) => (
            <p key={l}>{l}</p>
          ))}
          {(seller.email || seller.phone) && <p className="text-[#5d6576]">{[seller.email, seller.phone].filter(Boolean).join(" · ")}</p>}
        </div>
        <div className="text-right">
          <p className="text-xl font-semibold tracking-tight">
            {DOCUMENT_TYPE_LABELS[doc.type]} n° {doc.number}
          </p>
          <p>Date d&apos;émission : {formatDate(doc.issueDate!)}</p>
          {doc.deliveryDate && <p>Date de livraison / d&apos;exécution : {formatDate(doc.deliveryDate)}</p>}
          {doc.type === "invoice" && doc.dueDate && <p className="font-medium">Échéance : {formatDate(doc.dueDate)}</p>}
          {isQuote && doc.dueDate && <p>Valable jusqu&apos;au {formatDate(doc.dueDate)}</p>}
          {doc.type === "credit_note" && sourceNumber && <p className="font-medium">Avoir sur la facture n° {sourceNumber}</p>}
        </div>
      </header>

      <section className="grid gap-6 py-6 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#8a92a3]">Client</p>
          <p className="font-medium">{customer.name}</p>
          {customer.billingAddress.map((l) => (
            <p key={l}>{l}</p>
          ))}
          {customer.siren && <p>SIREN : {customer.siren}</p>}
          {customer.vatNumber && <p>N° TVA : {customer.vatNumber}</p>}
          <p className="text-[#5d6576]">Réf. client : {customer.code}</p>
        </div>
        {customer.shippingAddress && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#8a92a3]">Adresse de livraison</p>
            {customer.shippingAddress.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
        )}
      </section>

      {doc.operationCategory && <p className="mb-3 text-[#5d6576]">Nature de l&apos;opération : {CATEGORY[doc.operationCategory]}</p>}

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-[#d0d5dd] text-left text-[11px] uppercase tracking-wider text-[#5d6576]">
            <th className="py-2 pr-2 font-medium">Désignation</th>
            <th className="px-2 py-2 text-right font-medium">Qté</th>
            <th className="px-2 py-2 text-right font-medium">PU HT</th>
            <th className="px-2 py-2 text-right font-medium">Remise</th>
            <th className="px-2 py-2 text-right font-medium">TVA</th>
            <th className="py-2 pl-2 text-right font-medium">Total HT</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-b border-[#e4e7ec] align-top">
              <td className="py-2 pr-2">
                {l.reference && <span className="mr-1 font-mono text-[10px] text-[#8a92a3]">{l.reference}</span>}
                <span className="whitespace-pre-line">{l.description}</span>
              </td>
              <td className="tabular whitespace-nowrap px-2 py-2 text-right">
                {dec(l.quantity).toString().replace(".", ",")} {l.unit}
              </td>
              <td className="tabular whitespace-nowrap px-2 py-2 text-right">{formatUnitPrice(l.unitPriceExclTax)}</td>
              <td className="tabular px-2 py-2 text-right">{dec(l.discountPercent).isZero() ? "—" : formatRate(l.discountPercent)}</td>
              <td className="tabular whitespace-nowrap px-2 py-2 text-right">{formatRate(l.vatRate)}</td>
              <td className="tabular whitespace-nowrap py-2 pl-2 text-right">{formatEuro(l.totalExclTax)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="mt-6 flex flex-wrap justify-between gap-6">
        <div className="max-w-sm space-y-1 text-[#5d6576]">
          {exemptions.map((e) => (
            <p key={e} className="font-medium text-[#1f2430]">
              {e}
            </p>
          ))}
          {seller.vatOnDebits && <p>Option pour le paiement de la TVA d&apos;après les débits.</p>}
        </div>
        <dl className="w-64 space-y-1">
          {!globalDiscount.isZero() && (
            <>
              <div className="flex justify-between">
                <dt>Total lignes HT</dt>
                <dd className="tabular">{formatEuro(linesTotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Remise globale ({formatRate(doc.globalDiscountPercent)})</dt>
                <dd className="tabular">-{formatEuro(globalDiscount)}</dd>
              </div>
            </>
          )}
          <div className="flex justify-between">
            <dt>Total HT</dt>
            <dd className="tabular">{formatEuro(doc.totalExclTax)}</dd>
          </div>
          {vat.map((v) => (
            <div key={`${v.vatRate}-${v.vatExemptionReason}`} className="flex justify-between text-[#5d6576]">
              <dt>
                TVA {formatRate(v.vatRate)} sur {formatEuro(v.baseExclTax)}
              </dt>
              <dd className="tabular">{formatEuro(v.vatAmount)}</dd>
            </div>
          ))}
          <div className="flex justify-between border-t border-[#d0d5dd] pt-1 text-sm font-semibold">
            <dt>Total TTC</dt>
            <dd className="tabular">{formatEuro(doc.totalInclTax)}</dd>
          </div>
        </dl>
      </section>

      {doc.notes && <p className="mt-6 whitespace-pre-line">{doc.notes}</p>}

      {isQuote && (
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div />
          <div className="h-24 rounded border border-dashed border-[#d0d5dd] p-3 text-[#8a92a3]">
            Bon pour accord — date et signature du client
          </div>
        </div>
      )}

      <footer className="mt-8 space-y-1 border-t border-[#e4e7ec] pt-4 text-[10px] text-[#5d6576]">
        {doc.type === "invoice" && (
          <>
            {seller.iban && (
              <p>
                Règlement par virement : IBAN {seller.iban}
                {seller.bic ? ` — BIC ${seller.bic}` : ""}
              </p>
            )}
            {/* Pénalités et indemnité forfaitaire de 40 € : obligations entre professionnels (C. com. L. 441-10). */}
            {professionalCustomer && seller.latePenaltyText && <p>{seller.latePenaltyText}</p>}
          </>
        )}
        <p>
          {[
            seller.legalName,
            seller.legalForm && seller.shareCapital ? `${seller.legalForm} au capital de ${formatEuro(seller.shareCapital)}` : seller.legalForm,
            seller.siren ? `SIREN ${seller.siren}` : null,
            seller.rcsCity,
            seller.siret ? `SIRET ${seller.siret}` : null,
            seller.vatNumber ? `TVA ${seller.vatNumber}` : null,
            seller.nafCode ? `APE ${seller.nafCode}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {seller.legalMentions && <p>{seller.legalMentions}</p>}
        <p className="font-mono text-[9px] text-[#8a92a3]">Empreinte d&apos;intégrité : {doc.contentHash}</p>
      </footer>
    </article>
  );
}
