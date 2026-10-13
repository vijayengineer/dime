"use client";

import { useMemo, useState } from "react";
import { AccountSheet } from "@/components/Shell";
import { PriceChart, type ChartLine } from "@/components/play/PriceChart";
import { PriceHeader } from "@/components/play/PriceHeader";
import { IntentCard, PositionCard, SettlementCard } from "@/components/play/Live";
import { OrderTicket } from "@/components/play/OrderTicket";
import { price as fmtPrice, usd as fmtUsd } from "@/components/format";
import { FeedGate } from "@/components/ui";
import { priceUsable, TERMINAL_INTENT, type Quote } from "@/domain/types";
import { useApp } from "@/state/app";
import { feedValue, useServices } from "@/state/services";

export default function PlayPage() {
  const s = useServices();
  const app = useApp();
  const snap = feedValue(app.price);
  const params = feedValue(app.params);
  const position = feedValue(app.position) ?? null;
  const intent = feedValue(app.intent) ?? null;
  const house = feedValue(app.house);
  const signedIn = !!feedValue(app.account);
  const [preview, setPreview] = useState<Quote | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [funding, setFunding] = useState(false);

  const lines = useMemo<ChartLine[]>(() => {
    if (position) return [
      { price: position.entryPrice, label: "Entry", kind: "entry" },
      { price: position.liquidationPrice, label: "Liq", kind: "liq" },
    ];
    if (preview) return [{ price: preview.liquidationPrice, label: "Liq if opened now", kind: "preview-liq" }];
    return [];
  }, [position, preview]);

  // Once opened, the position card (or its settlement) represents the request.
  const showIntent = intent && !dismissed.has(intent.id) && intent.status !== "OPENED";
  const intentBusy = intent && !TERMINAL_INTENT.has(intent.status);

  const chartLabel = snap
    ? `BTC indicative price chart. Latest ${fmtPrice(snap.estimate)}.${position ? ` Entry ${fmtPrice(position.entryPrice)}, liquidation ${fmtPrice(position.liquidationPrice)}.` : ""}`
    : "BTC price chart loading";

  return (
    <>
    {!position && !intentBusy && (
      <section className="hero-strip" aria-label="About">
        <div>
          <h1>{s.mode === "demo" ? <>Paper trade BTC, <em>dime-sized.</em></> : <>Trade BTC, <em>dime-sized.</em></>}</h1>
          <p>Go long or short on BTC against another trader or the house. Your margin is the most you can lose.</p>
        </div>
        {params && (
          <div className="hero-facts">
            <span>from <b>{fmtUsd(params.minMargin)}</b></span>
            <span>up to <b>{params.maxLeverage}×</b></span>
            <span>max loss <b>= your margin</b></span>
          </div>
        )}
      </section>
    )}
    <div className="grid-play">
      <section className="card" aria-label="BTC price">
        <FeedGate feed={app.price} label="Price">
          {(p) => <PriceHeader snap={p} demo={s.mode === "demo"} />}
        </FeedGate>
        <PriceChart points={app.series} lines={lines} ariaLabel={chartLabel} />
        <div className="chart-legend" aria-hidden={lines.length === 0}>
          <span><i style={{ borderColor: "var(--chalk)", borderTopStyle: "solid" }} />Indicative price (estimate)</span>
          {position && <span><i style={{ borderColor: "var(--yellow)" }} />Your entry</span>}
          {(position || preview) && <span><i style={{ borderColor: "var(--bad)" }} />Liquidation{position ? "" : " (if opened now)"}</span>}
        </div>
      </section>

      <div className="stack">
        {app.lastSettlement && <SettlementCard s={app.lastSettlement} onDone={app.dismissSettlement} />}
        {showIntent && <IntentCard intent={intent} onDismiss={() => setDismissed(new Set(dismissed).add(intent.id))} />}
        {position && params && <PositionCard position={position} snap={snap} params={params} />}
        {!position && !intentBusy && !app.lastSettlement && (
          <FeedGate feed={app.params} label="Protocol configuration">
            {(pr) => (
              <OrderTicket
                params={pr}
                balances={feedValue(app.balances)}
                state={house?.state ?? "OPEN"}
                priceOk={priceUsable(snap?.quality)}
                signedIn={signedIn}
                onPreview={setPreview}
                onNeedFunds={() => setFunding(true)}
              />
            )}
          </FeedGate>
        )}
      </div>
      <AccountSheet open={funding} onClose={() => setFunding(false)} />
    </div>
    </>
  );
}
