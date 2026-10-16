"use client";

import { toFloat } from "@/domain/fixed";

/**
 * DIME issued per $1 of eligible house loss vs house reserve (log x-axis).
 * Flat at the base rate up to the decay threshold, then base × threshold / reserve.
 * Single series, so no legend; the dot marks the current reserve.
 */
export function RewardCurve({ baseE18, decayTvl, reserve, curve = "cubic" }: { baseE18: bigint; decayTvl: bigint; reserve: bigint; curve?: "cubic" | "inverse" }) {
  const W = 360, H = 150, PL = 40, PR = 26, PT = 12, PB = 28;
  const base = toFloat(baseE18, 18);
  const t0 = Math.max(1, toFloat(decayTvl, 6));
  const xMin = 1, xMax = Math.max(t0 * 100, 1e8);
  const lx = (v: number) => PL + ((Math.log10(Math.max(v, xMin)) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin))) * (W - PL - PR);
  const rate = (v: number) => (v <= t0 ? base : base * (t0 / v) ** (curve === "cubic" ? 3 : 1));
  const ly = (r: number) => PT + (1 - r / base) * (H - PT - PB);
  const pts: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const v = 10 ** (Math.log10(xMin) + (i / 60) * (Math.log10(xMax) - Math.log10(xMin)));
    pts.push(`${lx(v).toFixed(1)},${ly(rate(v)).toFixed(1)}`);
  }
  const cur = Math.max(xMin, toFloat(reserve, 6));
  const ticks = [1, 1e3, 1e6, 1e8].filter((t) => t <= xMax);
  const fmtUsd = (v: number) => (v >= 1e6 ? `$${v / 1e6}M` : v >= 1e3 ? `$${v / 1e3}k` : `$${v}`);
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
        aria-label={`DIME per $1 lost: ${base} up to ${fmtUsd(t0)} of house reserve, then falling. Current reserve ${fmtUsd(Math.round(cur))}, rate ${rate(cur).toPrecision(3)}.`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PL} x2={W - PR} y1={ly(base * f)} y2={ly(base * f)} stroke="var(--line)" strokeWidth="1" />
            <text x={PL - 6} y={ly(base * f) + 4} textAnchor="end" fontSize="10" fill="var(--chalk-3)" fontFamily="var(--font-jet)">{(base * f).toFixed(2)}</text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t} x={lx(t)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--chalk-3)" fontFamily="var(--font-jet)">{fmtUsd(t)}</text>
        ))}
        <polyline points={pts.join(" ")} fill="none" stroke="var(--monad-ink)" strokeWidth="2" strokeLinejoin="round" />
        <line x1={lx(cur)} x2={lx(cur)} y1={PT} y2={H - PB} stroke="var(--line-strong)" strokeDasharray="3 4" />
        <circle cx={lx(cur)} cy={ly(rate(cur))} r="5" fill="var(--yellow)" stroke="var(--board-2)" strokeWidth="2" />
      </svg>
      <figcaption className="note">DIME per $1 lost vs house reserve (log scale). Dot = now.</figcaption>
    </figure>
  );
}
