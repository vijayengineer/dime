"use client";

import { useMemo, useState, type ReactNode } from "react";
import { DEFAULTS, rateAt, simulate, throughput, type SimInputs } from "./model";

/* Series colours, validated for the dark board (#1f1e1c): lightness band, CVD and contrast all pass. */
const C = { a: "#8f7bff", b: "#21a593", c: "#b8891c" };

const money = (v: number, dp = 0) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: dp, minimumFractionDigits: dp })}`;
const short$ = (v: number) => (Math.abs(v) >= 1e6 ? `$${+(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `$${+(v / 1e3).toFixed(1)}k` : `$${+v.toFixed(0)}`);
const pctf = (v: number, dp = 1) => `${(v * 100).toFixed(dp)}%`;
const num = (v: number) => (v >= 100 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : v.toPrecision(2));

export function Lab() {
  const [p, setP] = useState<SimInputs>(DEFAULTS);
  const [lev, setLev] = useState(1000);
  const [vol, setVol] = useState(0.025);
  const [expCap, setExpCap] = useState(100);
  const [depCap, setDepCap] = useState(10);
  const set = <K extends keyof SimInputs>(k: K, v: SimInputs[K]) => setP((x) => ({ ...x, [k]: v }));

  const run = useMemo(() => simulate(p), [p]);
  const baseline = useMemo(() => simulate({ ...p, spend: 0 }), [p]);
  const tp = useMemo(() => throughput(p, lev, vol, expCap, depCap), [p, lev, vol, expCap, depCap]);

  const scenarios = useMemo(() => {
    const rows: [string, SimInputs][] = [
      ["Hedged pair, no defences", { ...p, strategy: "hedged", netLinked: false, perWalletCap: 0 }],
      ["Hedged pair, linked wallets netted", { ...p, strategy: "hedged", netLinked: true, perWalletCap: 0 }],
      ["Hedged pair, 100 DIME/wallet/day cap", { ...p, strategy: "hedged", netLinked: false, perWalletCap: 100 }],
      ["One-sided trading", { ...p, strategy: "oneSided", netLinked: false, perWalletCap: 0 }],
      ["Hedged pair on the old 1/x curve", { ...p, strategy: "hedged", netLinked: false, perWalletCap: 0, curve: "inverse" }],
    ];
    return rows.map(([name, q]) => ({ name, r: simulate(q) }));
  }, [p]);

  const last = run.days[run.days.length - 1];
  const taken = baseline.organicUsdc - run.organicUsdc;

  return (
    <div style={{ display: "grid", gap: 14, paddingBottom: 40 }}>
      <section className="card">
        <div className="card-title"><h2>DIME farming lab</h2><span className="tag">local only · not deployed</span></div>
        <p className="note" style={{ margin: 0 }}>
          What a DIME farmer spends, earns and ends up owning under a given issuance curve and set of defences. One step is one daily epoch,
          in the contract&apos;s order: last epoch&apos;s mints activate, new house earnings go to active stake, then losses mint pending DIME.
          It is a model with assumed inputs, not a forecast.
        </p>
      </section>

      <div className="house-grid">
        <section className="card" aria-label="Inputs">
          <Group title="Issuance">
            <Field label="DIME per $1 lost (below the knee)" v={p.baseRate} on={(v) => set("baseRate", v)} step={1} />
            <Field label="Knee: house reserve where it starts falling ($)" v={p.knee} on={(v) => set("knee", v)} step={100_000} />
            <Field label="Max DIME per epoch, all users (0 = off)" v={p.epochCap} on={(v) => set("epochCap", v)} step={10_000} />
          </Group>
          <Group title="House">
            <Field label="Starting house reserve ($)" v={p.reserve0} on={(v) => set("reserve0", v)} step={10_000} />
            <Field label="Profit fee" v={p.fee} on={(v) => set("fee", v)} step={0.01} pct />
            <Field label="Share of house earnings to stakers" v={p.share} on={(v) => set("share", v)} step={0.05} pct />
          </Group>
          <Group title="Real traders">
            <Field label="Eligible losses per day ($)" v={p.organicLoss} on={(v) => set("organicLoss", v)} step={1_000} />
            <Field label="House net earnings from them per day ($)" v={p.organicEarnings} on={(v) => set("organicEarnings", v)} step={500} />
            <Field label="DIME already staked by others" v={p.existingStake} on={(v) => set("existingStake", v)} step={10_000} />
          </Group>
          <Group title="Farmer">
            <div className="field">
              <span className="label">Strategy</span>
              <div style={{ display: "flex", gap: 8 }}>
                {(["hedged", "oneSided"] as const).map((s) => (
                  <button key={s} className={`btn small${p.strategy === s ? " primary" : ""}`} aria-pressed={p.strategy === s} onClick={() => set("strategy", s)}>
                    {s === "hedged" ? "Hedged pair" : "One-sided"}
                  </button>
                ))}
              </div>
            </div>
            <Field label="Net spend per day ($)" v={p.spend} on={(v) => set("spend", v)} step={50} />
            <Field label="Wallets" v={p.wallets} on={(v) => set("wallets", v)} step={1} />
            <Field label="Days" v={p.days} on={(v) => set("days", Math.max(1, Math.round(v)))} step={30} />
          </Group>
          <Group title="Defences">
            <label className="toggle"><input type="checkbox" checked={p.netLinked} onChange={(e) => set("netLinked", e.target.checked)} /> Net opposing house positions across linked wallets</label>
            <Field label="Max DIME per wallet per epoch (0 = off)" v={p.perWalletCap} on={(v) => set("perWalletCap", v)} step={10} />
          </Group>
          <button className="btn ghost small" style={{ marginTop: 14 }} onClick={() => setP(DEFAULTS)}>Reset</button>
        </section>

        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            <Tile label={`Farmer net after ${p.days} days`} value={money(last.farmerNet)} sub={`spent ${money(run.farmerCost)}, received ${money(run.farmerUsdc)} USDC`} />
            <Tile label="Payback" value={run.paybackDay ? `day ${run.paybackDay}` : "never"} sub="first day USDC received ≥ spend" />
            <Tile label="Farmer's share of DIME" value={pctf(last.farmerShare)} sub={`${num(run.farmerDime)} of ${num(run.totalDime)} DIME`} />
            <Tile label="Diverted from real stakers" value={money(taken)} sub="vs the same run with no farmer" />
          </div>

          <section className="card">
            <div className="card-title"><h2>Issuance curve</h2></div>
            <LineChart
              xLog yLog height={220}
              x={{ fmt: short$, label: "House reserve" }}
              y={{ fmt: num, label: "DIME per $1 lost" }}
              series={[
                { name: "New: cubic", color: C.a, pts: curvePts(p, "cubic") },
                { name: "Old: 1/x", color: C.c, dash: true, pts: curvePts(p, "inverse") },
              ]}
              marker={{ x: p.reserve0, label: "start" }}
            />
            <table className="lab-table">
              <thead><tr><th>House reserve</th>{[0.5, 1, 2, 5, 10].map((m) => <th key={m}>{short$(p.knee * m)}</th>)}</tr></thead>
              <tbody>
                <tr><td>New (cubic)</td>{[0.5, 1, 2, 5, 10].map((m) => <td key={m}>{num(rateAt(p.baseRate, p.knee, p.knee * m, "cubic"))}</td>)}</tr>
                <tr><td>Old (1/x)</td>{[0.5, 1, 2, 5, 10].map((m) => <td key={m}>{num(rateAt(p.baseRate, p.knee, p.knee * m, "inverse"))}</td>)}</tr>
              </tbody>
            </table>
          </section>

          <section className="card">
            <div className="card-title"><h2>Farmer cumulative net ($)</h2></div>
            <LineChart
              height={200}
              x={{ fmt: (d) => `d${Math.round(d)}`, label: "Day" }}
              y={{ fmt: short$, label: "USDC received − spend" }}
              zero
              series={[{ name: "Farmer net", color: C.a, pts: run.days.map((d) => [d.day, d.farmerNet]) }]}
            />
          </section>

          <section className="card">
            <div className="card-title"><h2>Farmer&apos;s share of all DIME</h2></div>
            <LineChart
              height={200}
              x={{ fmt: (d) => `d${Math.round(d)}`, label: "Day" }}
              y={{ fmt: (v) => pctf(v, 0), label: "Share" }}
              yMax={1}
              series={[{ name: "Farmer share", color: C.a, pts: run.days.map((d) => [d.day, d.farmerShare]) }]}
            />
          </section>

          <section className="card">
            <div className="card-title"><h2>Same spend, different rules</h2></div>
            <table className="lab-table">
              <thead><tr><th>Scenario</th><th>Farmer net</th><th>Payback</th><th>Share of DIME</th></tr></thead>
              <tbody>
                {scenarios.map(({ name, r }) => {
                  const l = r.days[r.days.length - 1];
                  return <tr key={name}><td>{name}</td><td>{money(l.farmerNet)}</td><td>{r.paybackDay ? `day ${r.paybackDay}` : "never"}</td><td>{pctf(l.farmerShare)}</td></tr>;
                })}
              </tbody>
            </table>
          </section>

          <section className="card">
            <div className="card-title"><h2>Can they actually trade that much?</h2></div>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
              <Field label="Leverage" v={lev} on={setLev} step={50} />
              <Field label="BTC daily volatility" v={vol} on={setVol} step={0.005} pct />
              <Field label="Exposure cap ($ notional)" v={expCap} on={setExpCap} step={10} />
              <Field label="Lifetime deposit cap per wallet ($)" v={depCap} on={setDepCap} step={1} />
            </div>
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Margin per position</dt><dd>{money(tp.margin, 2)}</dd>
              <dt>Round trips per day (BTC moves ±1/leverage)</dt><dd>{tp.cyclesPerDay.toFixed(1)}</dd>
              <dt>Eligible loss per {p.strategy === "hedged" ? "pair" : "wallet"} per day</dt><dd>{money(tp.eligiblePerPairDay, 2)}</dd>
              <dt>Eligible loss per wallet, lifetime</dt><dd>{money(tp.eligiblePerWalletLifetime, 0)}</dd>
              <dt>Allow-listed wallets needed</dt><dd>{tp.walletsNeeded.toLocaleString("en-US")}</dd>
            </dl>
            <p className="note" style={{ marginBottom: 0 }}>
              Round trips assume a random walk: BTC takes about (1/leverage)² ÷ σ² days to move ±1/leverage. The deposit cap counts all deposits
              for life, so a hedged wallet can churn about cap ÷ fee of loss before it needs outside money, and moving winnings between wallets uses up that cap.
            </p>
          </section>
        </div>
      </div>
      <style>{`
        .lab-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
        .lab-table th, .lab-table td { text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--line); font-family: var(--font-mono); }
        .lab-table th:first-child, .lab-table td:first-child { text-align: left; font-family: var(--font-body); }
        .lab-table th { color: var(--chalk-3); font-weight: 500; }
      `}</style>
    </div>
  );
}

function curvePts(p: SimInputs, curve: "cubic" | "inverse"): [number, number][] {
  const lo = Math.max(1_000, p.knee / 100), hi = p.knee * 20;
  return Array.from({ length: 80 }, (_, i) => {
    const r = 10 ** (Math.log10(lo) + (i / 79) * (Math.log10(hi) - Math.log10(lo)));
    return [r, rateAt(p.baseRate, p.knee, r, curve)];
  });
}

/* ------------------------------------------------------------------ pieces */

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <fieldset style={{ border: 0, padding: 0, margin: "0 0 10px" }}><legend className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".1em", marginTop: 10 }}>{title}</legend>{children}</fieldset>;
}

function Field({ label, v, on, step, pct }: { label: string; v: number; on: (v: number) => void; step: number; pct?: boolean }) {
  return (
    <div className="field" style={{ marginTop: 8 }}>
      <label>{label}{pct && <span className="num">{(v * 100).toFixed(1)}%</span>}</label>
      <input className="input num" type="number" value={v} step={step} min={0} onChange={(e) => on(Number(e.target.value) || 0)} />
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="muted" style={{ fontSize: 12.5 }}>{label}</div>
      <div className="num" style={{ fontSize: 26, marginTop: 4 }}>{value}</div>
      <div className="note" style={{ margin: "4px 0 0" }}>{sub}</div>
    </div>
  );
}

interface Series { name: string; color: string; dash?: boolean; pts: [number, number][] }

/** Small SVG line chart: one y-axis, recessive grid, crosshair + tooltip, legend for ≥2 series. */
function LineChart({ series, x, y, height, xLog, yLog, zero, yMax, marker }: {
  series: Series[]; x: { fmt: (v: number) => string; label: string }; y: { fmt: (v: number) => string; label: string };
  height: number; xLog?: boolean; yLog?: boolean; zero?: boolean; yMax?: number; marker?: { x: number; label: string };
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, PL = 58, PR = 16, PT = 10, PB = 28;
  const all = series.flatMap((s) => s.pts);
  const tx = (v: number) => (xLog ? Math.log10(Math.max(v, 1e-12)) : v);
  const ty = (v: number) => (yLog ? Math.log10(Math.max(v, 1e-12)) : v);
  const xs = all.map((p) => tx(p[0])), ys = all.map((p) => ty(p[1]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys, zero ? 0 : Infinity), y1 = yMax !== undefined ? ty(yMax) : Math.max(...ys, zero ? 0 : -Infinity);
  if (!yLog && !zero && yMax === undefined) y0 = Math.min(y0, 0);
  if (yMax !== undefined && !yLog) y0 = 0;
  if (y1 === y0) y1 = y0 + 1;
  const sx = (v: number) => PL + ((tx(v) - x0) / (x1 - x0 || 1)) * (W - PL - PR);
  const sy = (v: number) => PT + (1 - (ty(v) - y0) / (y1 - y0)) * (H - PT - PB);
  const yTicks = yLog
    ? Array.from({ length: Math.floor(y1) - Math.ceil(y0) + 1 }, (_, i) => 10 ** (Math.ceil(y0) + i))
    : [0, 0.25, 0.5, 0.75, 1].map((f) => y0 + f * (y1 - y0));
  const xTicks = xLog
    ? Array.from({ length: Math.floor(x1) - Math.ceil(x0) + 1 }, (_, i) => 10 ** (Math.ceil(x0) + i))
    : [0, 0.25, 0.5, 0.75, 1].map((f) => x0 + f * (x1 - x0));
  const base = series[0].pts;
  const hi = hover === null ? null : base[hover];

  function move(e: React.PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * (W - PL - PR);
    const xv = x0 + (px / (W - PL - PR)) * (x1 - x0);
    let best = 0;
    base.forEach((p, i) => { if (Math.abs(tx(p[0]) - xv) < Math.abs(tx(base[best][0]) - xv)) best = i; });
    setHover(best);
  }

  return (
    <figure style={{ margin: 0, position: "relative" }}>
      {series.length > 1 && (
        <div style={{ display: "flex", gap: 16, fontSize: 12.5, marginBottom: 6 }} className="muted">
          {series.map((s) => (
            <span key={s.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="22" height="8" aria-hidden><line x1="1" x2="21" y1="4" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash ? "4 3" : undefined} /></svg>
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${y.label} against ${x.label}`}>
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={PL} x2={W - PR} y1={sy(t)} y2={sy(t)} stroke="var(--line)" />
            <text x={PL - 6} y={sy(t) + 4} textAnchor="end" fontSize="11" fill="var(--chalk-3)" fontFamily="var(--font-jet)">{y.fmt(t)}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--chalk-3)" fontFamily="var(--font-jet)">{x.fmt(t)}</text>
        ))}
        {zero && !yLog && <line x1={PL} x2={W - PR} y1={sy(0)} y2={sy(0)} stroke="var(--line-strong)" />}
        {marker && <line x1={sx(marker.x)} x2={sx(marker.x)} y1={PT} y2={H - PB} stroke="var(--line-strong)" strokeDasharray="3 4" />}
        {series.map((s) => (
          <polyline key={s.name} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeDasharray={s.dash ? "6 4" : undefined}
            points={s.pts.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ")} />
        ))}
        {hi && (
          <g pointerEvents="none">
            <line x1={sx(hi[0])} x2={sx(hi[0])} y1={PT} y2={H - PB} stroke="var(--line-strong)" />
            {series.map((s) => s.pts[hover!] && (
              <circle key={s.name} cx={sx(s.pts[hover!][0])} cy={sy(s.pts[hover!][1])} r="4.5" fill={s.color} stroke="var(--board-2)" strokeWidth="2" />
            ))}
          </g>
        )}
        <rect x={PL} y={PT} width={W - PL - PR} height={H - PT - PB} fill="transparent" onPointerMove={move} onPointerLeave={() => setHover(null)} />
      </svg>
      {hi && (
        <div className="num" style={{ position: "absolute", top: series.length > 1 ? 26 : 0, left: `${(sx(hi[0]) / W) * 100}%`, transform: `translateX(${sx(hi[0]) > W / 2 ? "-105%" : "5%"})`, background: "var(--board-3)", border: "1px solid var(--line-strong)", borderRadius: 8, padding: "6px 8px", fontSize: 12, pointerEvents: "none", whiteSpace: "nowrap" }}>
          <div className="muted">{x.label}: {x.fmt(hi[0])}</div>
          {series.map((s) => s.pts[hover!] && <div key={s.name}><span style={{ color: s.color }}>●</span> {s.name}: {y.fmt(s.pts[hover!][1])}</div>)}
        </div>
      )}
    </figure>
  );
}
