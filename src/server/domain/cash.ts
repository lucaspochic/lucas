import { D, type Dec, dec, roundMoney } from "./money";

/**
 * Calcul d'un ticket de caisse à partir de prix TTC (usage du commerce de détail).
 *  1. Total TTC de ligne = arrondi(quantité × PU TTC × (1 − remise %)).
 *  2. Regroupement par taux : TTC du taux = Σ lignes.
 *  3. HT du taux = arrondi(TTC × 100 / (100 + taux)) ; TVA = TTC − HT.
 * Le TTC affiché au client est ainsi exactement celui encaissé. Fonction pure.
 */
export interface CashLineInput {
  quantity: string;
  unitPriceInclTax: string;
  vatRate: string;
  discountPercent?: string;
}

export function computeTicketTotals(lines: readonly CashLineInput[]) {
  if (lines.length === 0) throw new Error("Un ticket comporte au moins une ligne.");
  const HUNDRED = new D(100);
  const lineTotals = lines.map((l) => {
    const discount = dec(l.discountPercent ?? "0");
    if (discount.isNegative() || discount.greaterThan(100)) throw new Error("Remise invalide.");
    return roundMoney(dec(l.quantity).times(l.unitPriceInclTax).times(HUNDRED.minus(discount)).dividedBy(HUNDRED));
  });
  const byRate = new Map<string, Dec>();
  lines.forEach((l, i) => {
    const key = dec(l.vatRate).toFixed(2);
    byRate.set(key, (byRate.get(key) ?? new D(0)).plus(lineTotals[i]!));
  });
  const vat = [...byRate.entries()]
    .sort(([a], [b]) => dec(b).comparedTo(dec(a)))
    .map(([rate, ttc]) => {
      const ht = roundMoney(ttc.times(HUNDRED).dividedBy(HUNDRED.plus(rate)));
      return { vatRate: rate, inclTax: ttc.toFixed(2), exclTax: ht.toFixed(2), vat: ttc.minus(ht).toFixed(2) };
    });
  const sum = (k: "inclTax" | "exclTax" | "vat") => vat.reduce((a, v) => a.plus(v[k]), new D(0)).toFixed(2);
  return { lineTotals: lineTotals.map((t) => t.toFixed(2)), vat, totalInclTax: sum("inclTax"), totalExclTax: sum("exclTax"), totalVat: sum("vat") };
}

/** Rendu de monnaie : espèces reçues − part du ticket payée en espèces. */
export function changeDue(cashGiven: string, cashPart: string): string {
  const diff = dec(cashGiven).minus(cashPart);
  return diff.isNegative() ? "0.00" : diff.toFixed(2);
}

/** Bornes de période (AAAA-MM-JJ) pour les clôtures. */
export function monthBounds(isoDate: string) {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start: `${y}-${String(m).padStart(2, "0")}-01`, end };
}
