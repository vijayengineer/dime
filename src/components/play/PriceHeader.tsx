"use client";

import { useEffect, useRef, useState } from "react";
import type { PriceSnapshot } from "@/domain/types";
import { ago, pct, price } from "../format";
import { Prov } from "../ui";
import { LiveFeedChip } from "../FeedHealth";

export function qualityTag(q: PriceSnapshot["quality"]) {
  const cls = q === "OK" ? "ok" : q === "DEGRADED" || q === "CONFLICT" ? "warn" : "bad";
  const text = q === "OK" ? "Price checks OK"
    : q === "DEGRADED" ? "Degraded · Hyperliquid only"
    : q === "STALE" ? "Stale price" : q === "CONFLICT" ? "Sources disagree" : "Not enough sources";
  const title = q === "DEGRADED" ? "Too few exchanges are fresh, so the price is Hyperliquid's liquidity-weighted mid on its own (basis-adjusted)." : undefined;
  return <span className={`tag ${cls}`} title={title}>{text}</span>;
}

export function PriceHeader({ snap, demo }: { snap: PriceSnapshot; demo: boolean }) {
  // Brief up/down tint on each change; the number itself stays in text ink.
  const prev = useRef(snap.estimate);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (snap.estimate === prev.current) return;
    setDir(snap.estimate > prev.current ? "up" : "down");
    prev.current = snap.estimate;
    const t = setTimeout(() => setDir(null), 500);
    return () => clearTimeout(t);
  }, [snap.estimate]);
  return (
    <div className="price-head">
      <div>
        <div className="pair-label">BTC · USD</div>
        <div className={`hero-num price-num ${dir ?? ""}`} aria-live="off">{price(snap.estimate)}</div>
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
