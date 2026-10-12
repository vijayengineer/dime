"use client";

import type { PriceSnapshot } from "@/domain/types";
import { ago, pct, price } from "./format";

const QUOTE_LABEL: Record<string, string> = { USD: "USD spot", USDT: "USDT spot", USDC_PERP: "USDC perp" };

/** Per-venue feed health and index composition. Values are measured by the pricing service. */
export function FeedHealth({ snap }: { snap: PriceSnapshot }) {
  const sources = [...snap.sources].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const avail = snap.availability;
  const oracle = snap.crossChecks?.hyperliquidOracle;
  return (
    <div>
      {snap.liveMarketData && (
        <div className="stat-row" style={{ marginBottom: 12 }}>
          <div className="stat">
            <div className="label">Index availability</div>
            <div className="value">{avail ? `${avail.uptimePct.toFixed(2)}%` : "—"}</div>
            <div className="note">{avail ? `${avail.gaps} outage${avail.gaps === 1 ? "" : "s"} · longest ${avail.maxGapMs ? ago(avail.maxGapMs) : "0"} · over ${ago(avail.sinceMs)}` : "measuring"}</div>
          </div>
          <div className="stat">
            <div className="label">Weighted vs plain median</div>
            <div className="value">{snap.divergenceBps != null ? `${snap.divergenceBps.toFixed(3)} bp` : "—"}</div>
            <div className="note">{snap.plainMedian ? `plain ${price(snap.plainMedian)}` : ""}</div>
          </div>
          <div className="stat">
            <div className="label">Source disagreement</div>
            <div className="value">{snap.disagreementBps.toFixed(2)} bp</div>
            <div className="note">basis-adjusted, used venues</div>
          </div>
          {oracle && (
            <div className="stat">
              <div className="label">Hyperliquid oracle</div>
              <div className="value">{oracle.deviationBps >= 0 ? "+" : ""}{oracle.deviationBps.toFixed(1)} bp</div>
              <div className="note">cross-check only · USDT-denominated venues</div>
            </div>
          )}
        </div>
      )}
      <div className="table-scroll">
        <table className="t">
          <thead>
            <tr><th>Venue</th><th>Price (adj.)</th><th>Weight</th><th>Links</th><th>Uptime</th><th>Gaps · max</th><th>Lat. p50</th><th>Age</th></tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const h = s.health;
              return (
                <tr key={s.id} style={s.used === false ? { opacity: 0.55 } : undefined}>
                  <td>
                    {s.name}
                    <div className="note">{s.quote ? QUOTE_LABEL[s.quote] ?? s.quote : ""}{s.used === false ? " · excluded" : ""}</div>
                  </td>
                  <td>{price(s.price)}</td>
                  <td style={{ minWidth: 90 }}>
                    {s.weight != null ? (
                      <div title={`${(s.weight * 100).toFixed(1)}% of the weighted median`}>
                        <div style={{ height: 6, borderRadius: 3, background: "var(--board)", border: "1px solid var(--line)", overflow: "hidden" }}>
                          <div style={{ width: `${Math.min(100, s.weight * 250)}%`, height: "100%", background: "var(--chalk-2)" }} />
                        </div>
                        <span className="note">{(s.weight * 100).toFixed(1)}%</span>
                      </div>
                    ) : "—"}
                  </td>
                  <td>
                    {h ? (
                      <span title={`${h.connectionsUp}/${h.connections} connections up · ${h.reconnects} reconnects · ${h.duplicates} duplicate updates absorbed`}>
                        {Array.from({ length: h.connections }, (_, i) => (
                          <span key={i} className={`dot ${i < h.connectionsUp ? "ok" : "bad"}`} style={{ display: "inline-block", marginRight: 4 }} />
                        ))}
                        <span className="note">{h.connectionsUp}/{h.connections}</span>
                      </span>
                    ) : "—"}
                  </td>
                  <td>{h ? `${h.uptimePct.toFixed(2)}%` : "—"}</td>
                  <td>{h ? `${h.gaps} · ${h.maxGapMs ? ago(h.maxGapMs) : "0"}` : "—"}</td>
                  <td>{h?.latencyP50 != null ? `${Math.round(h.latencyP50)}ms` : "—"}</td>
                  <td>{s.ageMs != null ? ago(s.ageMs) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note">
        {snap.method ?? "Median of sources"}. Weights are liquidity (top-of-book notional) × freshness, capped at 40% per venue.
        Gaps are intervals over 1 s between updates (a quiet market or an outage; links show which). Venues with two links
        run redundant connections, so one can drop without a gap. Latency is venue timestamp → received (includes clock skew).
      </p>
    </div>
  );
}

export function LiveFeedChip({ snap }: { snap: PriceSnapshot }) {
  if (!snap.liveMarketData) return null;
  const venues = snap.sources.filter((s) => s.used !== false).length;
  return (
    <span className="tag ok" title={snap.method}>
      Live market · {venues} venue{venues === 1 ? "" : "s"}{snap.availability ? ` · ${snap.availability.uptimePct.toFixed(1)}% up` : ""}
    </span>
  );
}

export { pct };
