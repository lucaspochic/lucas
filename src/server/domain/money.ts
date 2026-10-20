import Decimal from "decimal.js";

/**
 * Arithmétique monétaire décimale.
 *
 * Règles (voir docs/04-regles-calcul.md) :
 *  - aucun nombre flottant JavaScript n'est utilisé pour un montant ;
 *  - les montants transitent sous forme de chaînes décimales ("123.45") entre la base
 *    (type numeric) et le domaine ;
 *  - l'arrondi monétaire est l'arrondi commercial « au demi supérieur » (ROUND_HALF_UP,
 *    0,005 → 0,01 ; -0,005 → -0,01), au centime.
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export const MONEY_SCALE = 2;
export const UNIT_PRICE_SCALE = 4;
export const QUANTITY_SCALE = 3;

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** Convertit une valeur d'entrée en décimal ; refuse les nombres JS non entiers et les formats ambigus. */
export function dec(value: string | number | Dec): Dec {
  if (value instanceof D) return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError("Les montants non entiers doivent être fournis sous forme de chaîne décimale.");
    }
    return new D(value);
  }
  const normalized = value.trim();
  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new TypeError(`Valeur décimale invalide : « ${value} »`);
  }
  return new D(normalized);
}

/** Arrondi monétaire au centime (ROUND_HALF_UP, symétrique autour de zéro). */
export function roundMoney(value: Dec): Dec {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

/** Représentation canonique d'un montant, toujours 2 décimales : "1234.50". */
export function toMoneyString(value: Dec): string {
  return roundMoney(value).toFixed(MONEY_SCALE);
}

export function sum(values: readonly Dec[]): Dec {
  return values.reduce<Dec>((acc, v) => acc.plus(v), new D(0));
}

/** Formatage d'affichage français : « 1 234,50 € ». Ne jamais réutiliser pour un calcul. */
export function formatEuro(value: string | Dec, currency = "EUR"): string {
  const d = typeof value === "string" ? dec(value) : value;
  const negative = d.isNegative() && !d.isZero();
  const [intPart, fracPart] = roundMoney(d.abs()).toFixed(MONEY_SCALE).split(".");
  const grouped = (intPart ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const symbol = currency === "EUR" ? "€" : currency;
  return `${negative ? "-" : ""}${grouped},${fracPart} ${symbol}`;
}
