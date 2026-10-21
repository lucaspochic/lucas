"use client";

import { useState } from "react";

/**
 * Barres groupées mensuelles (2 séries, même unité : euros).
 * Couleurs validées (contraste ≥ 3:1, séparation daltonisme ΔE 29,7) : indigo / orange.
 * Survol : info-bulle par mois ; tableau de données accessible en alternative.
 */

const SERIES = [
  { key: "a", color: "#3b3fb6" },
  { key: "b", color: "#eb6834" },
] as const;

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const euro = (v: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);

/** Graduation « ronde » au-dessus du maximum. */
function niceMax(v: number) {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((c) => c >= v)!;
}

export function MonthlyChart({
  months,
  seriesA,
  seriesB,
  labelA,
  labelB,
}: {
  months: string[];
  seriesA: string[];
  seriesB: string[];
  labelA: string;
  labelB: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  // Valeurs d'affichage uniquement (aucun calcul financier) : conversion en nombre admise.
  const a = seriesA.map(Number);
  const b = seriesB.map(Number);
  const max = niceMax(Math.max(...a, ...b, 0));
  const min = Math.min(...a, ...b, 0) < 0 ? -niceMax(-Math.min(...a, ...b)) : 0;
  const W = 720;
  const H = 220;
  const pad = { l: 56, r: 8, t: 8, b: 28 };
  const plotH = H - pad.t - pad.b;
  const y = (v: number) => pad.t + ((max - v) / (max - min)) * plotH;
  const band = (W - pad.l - pad.r) / months.length;
  const barW = Math.min(14, (band - 10) / 2);
  const ticks = [min, (max + min) / 2, max].filter((v, i, s) => s.indexOf(v) === i);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-foreground-muted">
        {[labelA, labelB].map((label, i) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: SERIES[i]!.color }} aria-hidden />
            {label}
          </span>
        ))}
        <button type="button" onClick={() => setShowTable((s) => !s)} className="ml-auto text-accent hover:underline">
          {showTable ? "Voir le graphique" : "Voir les données"}
        </button>
      </div>
      {showTable ? (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-foreground-muted">
              <th className="py-1.5 font-medium">Mois</th>
              <th className="py-1.5 text-right font-medium">{labelA}</th>
              <th className="py-1.5 text-right font-medium">{labelB}</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m, i) => (
              <tr key={m} className="border-b border-border last:border-0">
                <td className="py-1.5">{monthLabel(m)}</td>
                <td className="tabular py-1.5 text-right">{euro(a[i]!)}</td>
                <td className="tabular py-1.5 text-right">{euro(b[i]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${labelA} et ${labelB} sur 12 mois`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-border)" strokeWidth={1} />
                <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-foreground-subtle)">
                  {euro(t)}
                </text>
              </g>
            ))}
            {months.map((m, i) => {
              const x0 = pad.l + i * band + (band - (barW * 2 + 2)) / 2;
              const bar = (v: number, x: number, color: string) => {
                const top = Math.min(y(v), y(0));
                const h = Math.max(Math.abs(y(v) - y(0)), v === 0 ? 0 : 1);
                return <rect x={x} y={top} width={barW} height={h} rx={3} fill={color} opacity={hover === null || hover === i ? 1 : 0.35} />;
              };
              return (
                <g key={m} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={pad.l + i * band} y={pad.t} width={band} height={plotH} fill="transparent" />
                  {bar(a[i]!, x0, SERIES[0].color)}
                  {bar(b[i]!, x0 + barW + 2, SERIES[1].color)}
                  {(i % 2 === 1 || months.length <= 6) && (
                    <text x={pad.l + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--color-foreground-subtle)">
                      {monthLabel(m)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-2 rounded-md border border-border bg-background px-3 py-2 text-xs shadow-popover"
              style={{ left: `${Math.min(80, ((pad.l + hover * band + band) / W) * 100)}%` }}
            >
              <p className="mb-1 font-medium">{monthLabel(months[hover]!)}</p>
              <p className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm" style={{ background: SERIES[0].color }} aria-hidden />
                {labelA} : <span className="tabular font-medium">{euro(a[hover]!)}</span>
              </p>
              <p className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm" style={{ background: SERIES[1].color }} aria-hidden />
                {labelB} : <span className="tabular font-medium">{euro(b[hover]!)}</span>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
