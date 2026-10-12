"use client";

/**
 * A chalk-drawn stack of dimes that grows with your stake (log scale, so small and large stakes
 * both read). Cosmetic only — it has no effect on rewards. Pending (not yet earning) coins are
 * drawn dashed on top.
 */
export function DimeStack({ active, pending, minStake }: { active: bigint; pending: bigint; minStake: bigint }) {
  const unit = minStake > 0n ? minStake : 10n ** 17n;
  const coinsFor = (v: bigint) => (v <= 0n ? 0 : Math.min(14, Math.max(1, Math.round(Math.log2(Number(v) / Number(unit) + 1) * 3))));
  const solid = coinsFor(active);
  const total = Math.min(14, coinsFor(active + pending));
  const dashed = Math.max(0, total - solid);
  const W = 150, H = 170, CX = 75, RX = 52, RY = 13, STEP = 9, BASE = H - 22;

  return (
    <svg className="dime-stack" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img"
      aria-label={total === 0 ? "No DIME staked yet" : `${solid} coins earning, ${dashed} activating next epoch`}>
      {/* shadow / table line */}
      <path d={`M10 ${BASE + RY + 6} Q ${CX} ${BASE + RY + 12} ${W - 10} ${BASE + RY + 6}`} stroke="var(--line-strong)" strokeWidth="1.5" fill="none" strokeDasharray="2 5" />
      {total === 0 && (
        <ellipse cx={CX} cy={BASE} rx={RX} ry={RY} fill="none" stroke="var(--chalk-3)" strokeWidth="2" strokeDasharray="4 5" />
      )}
      {Array.from({ length: total }, (_, i) => {
        const y = BASE - i * STEP;
        const isPending = i >= solid;
        const top = i === total - 1;
        const stroke = isPending ? "var(--monad-ink)" : "var(--yellow)";
        return (
          <g key={i} className="coin" style={{ animationDelay: `${i * 40}ms` }}>
            <path d={`M${CX - RX} ${y} v${STEP - 1} a${RX} ${RY} 0 0 0 ${RX * 2} 0 v${-(STEP - 1)}`}
              fill={isPending ? "rgba(110,84,255,.10)" : "rgba(242,208,107,.14)"} stroke={stroke} strokeWidth="1.8" strokeDasharray={isPending ? "4 4" : undefined} />
            {/* reeded edge */}
            {!isPending && Array.from({ length: 9 }, (_, k) => {
              const x = CX - RX + 8 + k * ((RX * 2 - 16) / 8);
              return <line key={k} x1={x} x2={x} y1={y + 2} y2={y + STEP - 2} stroke="var(--yellow)" strokeOpacity=".35" strokeWidth="1" />;
            })}
            <ellipse cx={CX} cy={y} rx={RX} ry={RY} fill="var(--board-2)" stroke={stroke} strokeWidth="1.8" strokeDasharray={isPending ? "4 4" : undefined} />
            {top && (
              <text x={CX} y={y + 5} textAnchor="middle" fontFamily="var(--font-sketch)" fontWeight="700" fontSize="15" fill={stroke}>10¢</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
