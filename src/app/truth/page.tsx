"use client";

import { useSyncExternalStore } from "react";
import type { DemoScenario } from "@/adapters/types";
import { ago, pct, price, shortHash, time, usd } from "@/components/format";
import { qualityTag } from "@/components/play/PriceHeader";
import { FeedHealth } from "@/components/FeedHealth";
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
          what the chain and the indexer say, and how fast things really are. Every number is tagged:{" "}
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
          <section className="card" aria-labelledby="idx-title">
            <div className="card-title"><h2 id="idx-title">Indexer</h2><Prov p="INDEXED" demo={demo} /></div>
            <FeedGate feed={app.indexer} label="Indexer status">
              {(i) => (
                <dl className="kv">
                  <dt>Indexed block</dt><dd>{i.indexedBlock?.toString() ?? "—"}</dd>
                  <dt>Block hash</dt><dd>{shortHash(i.indexedHash ?? undefined)}</dd>
                  <dt>Chain head</dt><dd>{i.chainHead?.toString() ?? "—"}</dd>
                  <dt>Lag</dt><dd>{i.lagBlocks ?? "—"} blocks · {i.lagMs != null ? ago(i.lagMs) : "—"}</dd>
                </dl>
              )}
            </FeedGate>
          </section>
      </div>

      <section className="card" aria-labelledby="hist-title">
        <div className="card-title"><h2 id="hist-title">Your history</h2><Prov p="INDEXED" demo={demo} /></div>
        <FeedGate feed={app.history} label="History">
          {(items) => items.length === 0
            ? <div className="empty"><span className="display">Clean slate</span>Deposits, requests, settlements and claims will appear here once indexed.</div>
            : <ul className="list">{items.map((e) => <HistoryRow key={e.id} e={e} explorer={s.chain.explorer} />)}</ul>}
        </FeedGate>
      </section>

      <Metrics demo={demo} />
      {s.demo && app.scenario && <ScenarioLab scenario={app.scenario} />}
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

function Metrics({ demo }: { demo: boolean }) {
  useSyncExternalStore(subscribeMetrics, metricsVersion, () => 0);
  const m = summary();
  const o = m.outcomes;
  const requests = o.matched + o.houseFallback + o.expired + o.capacityUnavailable + o.rejected + o.cancelled + o.stalePriceRejected;
  const f = (v: number | null) => (v == null ? "—" : `${Math.round(v)}ms`);
  return (
    <section className="card" aria-labelledby="perf-title">
      <div className="card-title"><h2 id="perf-title">Measured in this browser</h2><span className="tag">{demo ? "demo timings" : "live"}</span></div>
      {demo && <p className="warn-box">Demo timings measure the local engine&apos;s artificial delays, not Monad, the backend or Envio. Don&apos;t quote them as performance.</p>}
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

function ScenarioLab({ scenario }: { scenario: DemoScenario }) {
  const s = useServices();
  const d = s.demo!;
  const opt = <K extends keyof DemoScenario>(k: K, values: DemoScenario[K][], label: string) => (
    <div className="field">
      <span className="label">{label}</span>
      <div className="chips" role="group" aria-label={label}>
        {values.map((v) => (
          <button key={String(v)} className="chip" aria-pressed={scenario[k] === v} onClick={() => d.setScenario({ [k]: v } as Partial<DemoScenario>)}>{String(v).replace("_", " ").toLowerCase()}</button>
        ))}
      </div>
    </div>
  );
  return (
    <section className="card" aria-labelledby="lab-title" style={{ borderStyle: "dashed", borderColor: "rgba(242,208,107,.5)" }}>
      <div className="card-title"><h2 id="lab-title">Scenario lab</h2><span className="tag demo">Demo only</span></div>
      <p className="note" style={{ marginTop: 0 }}>
        Force edge cases to review how the UI reports them. Not available in live mode.
        {d.liveFeed && " Prices are live market data, so synthetic gaps are disabled; the stale/conflict switches still override quality for testing."}
      </p>
      <div className="grid-2">
        <div>
          {opt("counterparty", ["available", "none"], "Matching counterparty")}
          {opt("houseCapacity", ["normal", "exhausted"], "House capacity")}
        </div>
        <div>
          {opt("oracle", ["ok", "stale", "conflict"], "Price sources")}
          {opt("protocolState", ["OPEN", "CLOSE_ONLY", "ORACLE_HOLD", "WIND_DOWN"], "Protocol state")}
        </div>
      </div>
      <div className="chips" style={{ marginTop: 14 }}>
        <button className="btn small" disabled={d.liveFeed} title={d.liveFeed ? "Disabled: prices are live market data" : undefined} onClick={() => d.priceShock(15)}>Gap +0.15%</button>
        <button className="btn small" disabled={d.liveFeed} title={d.liveFeed ? "Disabled: prices are live market data" : undefined} onClick={() => d.priceShock(-15)}>Gap −0.15%</button>
        <button className="btn small" onClick={() => d.counterpartyClose()}>Counterparty closes</button>
        <button className="btn small" onClick={() => d.fixtureHouseResult(-500_000n)}>Fixture wallet loses $0.50 to house</button>
        <button className="btn small" onClick={() => d.fixtureHouseResult(300_000n)}>Fixture wallet wins $0.30 net</button>
        <button className="btn small" onClick={() => d.advanceEpoch()}>End epoch</button>
        <button className="btn small danger" onClick={() => d.reset()}>Reset demo</button>
      </div>
      {d.liveFeed && <FailoverDrill />}
      <div>
      </div>
    </section>
  );
}

/** Demo-only: asks the (non-production) pricing service to kill one redundant link. */
function FailoverDrill() {
  const base = (process.env.NEXT_PUBLIC_PRICE_FEED_URL ?? "").replace(/^ws/, "http").replace(/\/feed$/, "");
  const drop = (source: string, conn: number) => fetch(`${base}/debug/drop?source=${source}&conn=${conn}`, { method: "POST" }).catch(() => {});
  return (
    <div style={{ marginTop: 14 }}>
      <div className="label" style={{ fontSize: 13, color: "var(--chalk-2)" }}>Failover drill (live feed)</div>
      <div className="chips" style={{ marginTop: 6 }}>
        <button className="btn small" onClick={() => drop("binance", 0)}>Drop Binance link #1</button>
        <button className="btn small" onClick={() => drop("hyperliquid", 0)}>Drop Hyperliquid link #1</button>
      </div>
      <p className="note">Watch Price feed health: the link dot goes red, the other link keeps updates flowing (gaps stay 0), and the dropped link reconnects with backoff on the next endpoint.</p>
    </div>
  );
}
