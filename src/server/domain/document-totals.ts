import { D, type Dec, dec, roundMoney, sum, toMoneyString, QUANTITY_SCALE, UNIT_PRICE_SCALE } from "./money";

/**
 * Calcul des totaux d'un document commercial (devis, facture, avoir, ticket).
 *
 * Méthode retenue (docs/04-regles-calcul.md §2) :
 *  1. Total HT de ligne = arrondi( quantité × PU HT × (1 − remise ligne %) ) au centime.
 *  2. Remise globale % : appliquée à chaque ligne après remise ligne, arrondie au centime
 *     par ligne (la remise est ainsi correctement ventilée par taux de TVA).
 *  3. Bases HT regroupées par taux de TVA (et par motif d'exonération pour le taux 0).
 *  4. TVA par taux = arrondi( base HT du taux × taux / 100 ) au centime.
 *  5. Total TTC = Σ bases HT + Σ TVA.
 *  6. Acomptes déjà facturés : déduits du TTC pour obtenir le net à payer (ils ne
 *     modifient pas la base TVA du document, déjà taxée lors de la facture d'acompte).
 *
 * Toutes les entrées et sorties sont des chaînes décimales. Fonction pure et déterministe.
 */

export interface LineInput {
  quantity: string;
  unitPriceExclTax: string;
  /** Taux de TVA en pourcentage : "20", "10", "5.5", "2.1", "0". */
  vatRate: string;
  /** Remise de ligne en pourcentage (0 à 100). */
  discountPercent?: string;
  /** Obligatoire si vatRate = 0 : mention justifiant l'exonération (ex. « art. 293 B du CGI »). */
  vatExemptionReason?: string;
}

export interface DocumentInput {
  lines: readonly LineInput[];
  /** Remise globale en pourcentage (0 à 100). */
  globalDiscountPercent?: string;
  /** Montant TTC des acomptes déjà facturés à déduire. */
  depositsInclTax?: string;
}

export interface LineResult {
  totalExclTaxBeforeGlobalDiscount: string;
  totalExclTax: string;
  vatRate: string;
}

export interface VatBreakdown {
  vatRate: string;
  vatExemptionReason: string | null;
  baseExclTax: string;
  vatAmount: string;
}

export interface DocumentTotals {
  lines: LineResult[];
  vatBreakdown: VatBreakdown[];
  totalExclTax: string;
  totalVat: string;
  totalInclTax: string;
  depositsInclTax: string;
  amountDue: string;
}

export class CalculationError extends Error {}

const HUNDRED = new D(100);

function percent(value: string | undefined, label: string): Dec {
  if (value === undefined || value === "") return new D(0);
  const p = dec(value);
  if (p.isNegative() || p.greaterThan(HUNDRED)) {
    throw new CalculationError(`${label} doit être comprise entre 0 et 100 %.`);
  }
  return p;
}

function checkScale(value: Dec, scale: number, label: string) {
  if (value.decimalPlaces() > scale) {
    throw new CalculationError(`${label} : ${scale} décimales au maximum.`);
  }
}

export function computeLineExclTax(line: LineInput): Dec {
  const qty = dec(line.quantity);
  const unit = dec(line.unitPriceExclTax);
  checkScale(qty, QUANTITY_SCALE, "Quantité");
  checkScale(unit, UNIT_PRICE_SCALE, "Prix unitaire");
  const discount = percent(line.discountPercent, "La remise de ligne");
  const gross = qty.times(unit);
  return roundMoney(gross.times(HUNDRED.minus(discount)).dividedBy(HUNDRED));
}

export function computeDocumentTotals(input: DocumentInput): DocumentTotals {
  if (input.lines.length === 0) {
    throw new CalculationError("Un document doit comporter au moins une ligne.");
  }
  const globalDiscount = percent(input.globalDiscountPercent, "La remise globale");

  const groups = new Map<string, { rate: Dec; reason: string | null; base: Dec }>();
  const lines: LineResult[] = input.lines.map((line) => {
    const rate = dec(line.vatRate);
    if (rate.isNegative() || rate.greaterThan(HUNDRED)) {
      throw new CalculationError("Taux de TVA invalide.");
    }
    const reason = rate.isZero() ? (line.vatExemptionReason?.trim() ?? "") : null;
    if (reason === "") {
      throw new CalculationError("Une ligne à 0 % de TVA doit indiquer le motif d'exonération.");
    }
    const beforeGlobal = computeLineExclTax(line);
    const afterGlobal = roundMoney(beforeGlobal.times(HUNDRED.minus(globalDiscount)).dividedBy(HUNDRED));

    const key = `${rate.toString()}|${reason ?? ""}`;
    const group = groups.get(key) ?? { rate, reason, base: new D(0) };
    group.base = group.base.plus(afterGlobal);
    groups.set(key, group);

    return {
      totalExclTaxBeforeGlobalDiscount: toMoneyString(beforeGlobal),
      totalExclTax: toMoneyString(afterGlobal),
      vatRate: rate.toString(),
    };
  });

  const vatBreakdown: VatBreakdown[] = [...groups.values()]
    .sort((a, b) => b.rate.comparedTo(a.rate))
    .map((g) => ({
      vatRate: g.rate.toString(),
      vatExemptionReason: g.reason,
      baseExclTax: toMoneyString(g.base),
      vatAmount: toMoneyString(roundMoney(g.base.times(g.rate).dividedBy(HUNDRED))),
    }));

  const totalExclTax = sum(vatBreakdown.map((v) => dec(v.baseExclTax)));
  const totalVat = sum(vatBreakdown.map((v) => dec(v.vatAmount)));
  const totalInclTax = totalExclTax.plus(totalVat);
  const deposits = input.depositsInclTax ? dec(input.depositsInclTax) : new D(0);
  if (deposits.isNegative()) throw new CalculationError("Le montant des acomptes ne peut pas être négatif.");
  if (deposits.greaterThan(totalInclTax.abs())) {
    throw new CalculationError("Les acomptes déduits dépassent le total TTC du document.");
  }

  return {
    lines,
    vatBreakdown,
    totalExclTax: toMoneyString(totalExclTax),
    totalVat: toMoneyString(totalVat),
    totalInclTax: toMoneyString(totalInclTax),
    depositsInclTax: toMoneyString(deposits),
    amountDue: toMoneyString(totalInclTax.minus(deposits)),
  };
}

/** Prix TTC indicatif d'un article de catalogue (affichage), arrondi au centime. */
export function priceInclTax(unitPriceExclTax: string, vatRate: string): string {
  const unit = dec(unitPriceExclTax);
  return toMoneyString(unit.times(HUNDRED.plus(dec(vatRate))).dividedBy(HUNDRED));
}
