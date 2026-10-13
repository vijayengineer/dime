"use client";

import { useSyncExternalStore } from "react";
import { ago, pct, price, shortHash, time, usd } from "@/components/format";
import { qualityTag } from "@/components/play/PriceHeader";
import { FeedHealth } from "@/components/FeedHealth";
import { EnvioIndexer, MonadChain } from "@/components/truth/MonadChain";
import { FeedGate, Prov } from "@/components/ui";
import type { ActivityItem, ProtocolState } from "@/domain/types";
import { useApp } from "@/state/app";
import { metricsVersion, subscribeMetrics, summary, type MetricKey } from "@/state/metrics";
import { feedValue, useServices } from "@/state/services";

const STATE_HELP: Record<ProtocolState, string> = {
  OPEN: "Accepting new positions within limits.",
  CLOSE_ONLY: "No new positions. Closes, liquidations and withdrawals continue.",
  ORACLE_HOLD: "Price verification failed. New positions and settlements wait for a verified price.",
  WIND_DOWN: "Positions are being settled in deterministic batches. No new risk.",
  INSOLVENT: "Liabilities exceed funded backing. Settlement follows the published shortfall policy.",
};

export default function TruthPage() {
  const s = useServices();
  const app = useApp();
  const demo = s.mode === "demo";

  return (
    <div className="stack">
      <header>
        <h1 className="display" style={{ fontSize: 40, margin: "4px 0 0" }}>Truth</h1>
        <p className="dim" style={{ marginTop: 4, maxWidth: 720 }}>
          What is actually true right now: where the price comes from and how healthy it is, the protocol&apos;s risk state,
          what Monad and the indexer say right now. Every number is tagged:{" "}
          <Prov p="ESTIMATE" /> model values, <Prov p="CONFIRMED" /> contract state, <Prov p="INDEXED" /> Envio history.
        </p>
      </header>

      <section className="card" aria-labelledby="px-title">
        <div className="card-title"><h2 id="px-title">Price feed health</h2><Prov p="ESTIMATE" demo={demo && !feedValue(app.price)?.liveMarketData} /></div>
        <FeedGate feed={app.price} label="Price">
          {(p) => (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {qualityTag(p.quality)}
                <span className="tag">max age {ago(p.ageMs)}</span>
                <span className="tag">disagreement {pct(p.disagreementBps)}</span>
              </div>
              <FeedHealth snap={p} />
              <dl className="kv" style={{ marginTop: 10 }}>
                <dt>Model estimate</dt><dd>{price(p.estimate)}</dd>
                <dt>Settlement reference <span className="note">({p.reference?.verifier ?? "none"})</span></dt>
                <dd>{p.reference ? price(p.reference.price) : "—"}</dd>
              </dl>
              <p className="note">The estimate is a model output, not proof of a fair price. Settlement uses the contract-verified reference.</p>
            </>
          )}
        </FeedGate>
      </section>

      <MonadChain />

      <div className="grid-2">
        <section className="card" aria-labelledby="risk-title">
            <div className="card-title"><h2 id="risk-title">Protocol risk state</h2></div>
            <FeedGate feed={app.house} label="Protocol state">
              {(h) => (
                <>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {(["OPEN", "CLOSE_ONLY", "ORACLE_HOLD", "WIND_DOWN", "INSOLVENT"] as ProtocolState[]).map((st) => (
                      <span key={st} className={`tag ${st === h.state ? (st === "OPEN" ? "ok" : st === "INSOLVENT" ? "bad" : "warn") : ""}`} style={st === h.state ? {} : { opacity: 0.45 }}>
                        {st.replace("_", " ")}
                      </span>
                    ))}
                  </div>
                  <p className="dim" style={{ marginBottom: 0 }}>{STATE_HELP[h.state]}</p>
                </>
              )}
            </FeedGate>
          </section>
          <EnvioIndexer />
      </div>

      <section className="card" aria-labelledby="hist-title">
        <div className="card-title"><h2 id="hist-title">Your history</h2><Prov p="INDEXED" demo={demo} /></div>
        <FeedGate feed={app.history} label="History">
          {(items) => items.length === 0
            ? <div className="empty"><span className="display">Clean slate</span>Deposits, requests, settlements and claims will appear here once indexed.</div>
            : <ul className="list">{items.map((e) => <HistoryRow key={e.id} e={e} explorer={s.chain.explorer} />)}</ul>}
        </FeedGate>
      </section>

      <Metrics />
    </div>
  );
}

function HistoryRow({ e, explorer }: { e: ActivityItem; explorer: string | null }) {
  const signed = e.kind === "POSITION_SETTLED";
  return (
    <li>
      <span className="num muted" style={{ fontSize: 12 }}>{time(e.at)}</span>
      <span>
        {e.title}
        <span className="note" style={{ display: "block" }}>
          block {e.block?.toString() ?? "—"} ·{" "}
          {explorer && e.txHash ? <a href={`${explorer}/tx/${e.txHash}`} target="_blank" rel="noreferrer">{shortHash(e.txHash)} ↗</a> : <span title="Demo transaction: no explorer">{shortHash(e.txHash)}</span>}
        </span>
      </span>
      <span className={`num ${signed && e.amount ? (e.amount > 0n ? "up" : "down") : ""}`}>
        {e.amount !== undefined && e.amount !== 0n ? (e.kind.startsWith("RIGHTS") ? `${(Number(e.amount) / 1e6).toFixed(2)} rights` : usd(e.amount, 3, signed)) : ""}
      </span>
    </li>
  );
}

const METRIC_LABEL: Record<MetricKey, string> = {
  quoteLatencyMs: "Quote latency",
  matchWaitMs: "Matching wait",
  submitToOpenMs: "Sign → position confirmed",
  closeToSettledMs: "Close → settled",
  eventToScreenMs: "Event → on screen (indexed)",
};

function Metrics() {
  useSyncExternalStore(subscribeMetrics, metricsVersion, () => 0);
  const m = summary();
  const o = m.outcomes;
  const requests = o.matched + o.houseFallback + o.expired + o.capacityUnavailable + o.rejected + o.cancelled + o.stalePriceRejected;
  const f = (v: number | null) => (v == null ? "—" : `${Math.round(v)}ms`);
  return (
    <section className="card" aria-labelledby="perf-title">
      <div className="card-title"><h2 id="perf-title">Measured in this browser</h2></div>
      <div className="table-scroll">
        <table className="t">
          <thead><tr><th>Measure</th><th>n</th><th>p50</th><th>p95</th><th>p99</th></tr></thead>
          <tbody>
            {(Object.keys(METRIC_LABEL) as MetricKey[]).map((k) => (
              <tr key={k}><td>{METRIC_LABEL[k]}</td><td>{m.latency[k].n}</td><td>{f(m.latency[k].p50)}</td><td>{f(m.latency[k].p95)}</td><td>{f(m.latency[k].p99)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        Requests: {requests} · matched {o.matched} · house {o.houseFallback} · expired {o.expired} · no capacity {o.capacityUnavailable} ·
        price rejections {o.stalePriceRejected} · other rejections {o.rejected} · cancelled {o.cancelled}
        {requests > 0 && ` · match acceptance ${((o.matched / requests) * 100).toFixed(0)}%`}
      </p>
    </section>
  );
}
