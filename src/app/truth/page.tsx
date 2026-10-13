"use client";

import { ago, pct, price, shortHash, time, usd } from "@/components/format";
import { qualityTag } from "@/components/play/PriceHeader";
import { FeedHealth } from "@/components/FeedHealth";
import { PriceFlow } from "@/components/PriceFlow";
import { EnvioIndexer, MonadBlocks, VerifiedStream } from "@/components/truth/MonadChain";
import { FeedGate, Prov } from "@/components/ui";
import type { ActivityItem } from "@/domain/types";
import { useApp } from "@/state/app";
import { feedValue, useServices } from "@/state/services";

export default function TruthPage() {
  const s = useServices();
  const app = useApp();
  const demo = s.mode === "demo";

  return (
    <div className="stack">
      <header>
        <h1 className="display" style={{ fontSize: 40, margin: "4px 0 0" }}>Truth</h1>
        <p className="dim" style={{ marginTop: 4, maxWidth: 720 }}>
          What is actually true right now: where the price comes from and how healthy it is,
          and what Monad and the indexer say. Every number is tagged:{" "}
          <Prov p="ESTIMATE" /> model values, <Prov p="CONFIRMED" /> contract state, <Prov p="INDEXED" /> Envio history.
        </p>
      </header>

      <section className="card" aria-labelledby="px-title">
        <div className="card-title"><h2 id="px-title">Price feed health</h2><Prov p="ESTIMATE" demo={demo && !feedValue(app.price)?.liveMarketData} /></div>
        <FeedGate feed={app.price} label="Price">
          {(p) => (
            <>
              <PriceFlow snap={p} />
              <VerifiedStream />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "14px 0 10px" }}>
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

      <EnvioIndexer />
      <MonadBlocks />

      <section className="card" aria-labelledby="hist-title">
        <div className="card-title"><h2 id="hist-title">Your history</h2><Prov p="INDEXED" demo={demo} /></div>
        <FeedGate feed={app.history} label="History">
          {(items) => items.length === 0
            ? <div className="empty"><span className="display">Clean slate</span>Deposits, requests, settlements and claims will appear here once indexed.</div>
            : <ul className="list">{items.map((e) => <HistoryRow key={e.id} e={e} explorer={s.chain.explorer} />)}</ul>}
        </FeedGate>
      </section>
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
