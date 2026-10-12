"use client";

import type { PriceSnapshot } from "@/domain/types";
import { ago, pct, price } from "../format";
import { Prov } from "../ui";
import { LiveFeedChip } from "../FeedHealth";

export function qualityTag(q: PriceSnapshot["quality"]) {
  const cls = q === "OK" ? "ok" : q === "STALE" || q === "INSUFFICIENT" ? "bad" : "warn";
  const text = q === "OK" ? "Price checks OK" : q === "STALE" ? "Stale price" : q === "CONFLICT" ? "Sources disagree" : "Not enough sources";
  return <span className={`tag ${cls}`}>{text}</span>;
}

export function PriceHeader({ snap, demo }: { snap: PriceSnapshot; demo: boolean }) {
  return (
    <div className="price-head">
      <div>
        <div className="muted" style={{ fontSize: 13 }}>BTC · USD</div>
        <div className="hero-num" aria-live="off">{price(snap.estimate)}</div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingBottom: 6 }}>
        <Prov p="ESTIMATE" demo={demo && !snap.liveMarketData} />
        <LiveFeedChip snap={snap} />
        {qualityTag(snap.quality)}
        <span className="tag" title="Age of freshest source">age {ago(snap.ageMs)}</span>
        <span className="tag" title="Max disagreement between sources">spread {pct(snap.disagreementBps)}</span>
        {snap.reference && (
          <span className="tag confirmed" title={`Settlement reference: ${snap.reference.verifier}`}>
            ref {price(snap.reference.price)}
          </span>
        )}
      </div>
    </div>
  );
}
