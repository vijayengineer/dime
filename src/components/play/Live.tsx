"use client";

import { useEffect, useState } from "react";
import { reasonText } from "@/domain/copy";
import type { ProtocolParams } from "@/config/protocol";
import { brand } from "@/config/brand";
import { cappedGrossPnl, distanceToLiqBps, profitFee } from "@/domain/math";
import { TERMINAL_INTENT, type IntentState, type Position, type PriceSnapshot, type Settlement } from "@/domain/types";
import { useServices } from "@/state/services";
import { INTENT_COPY } from "../StatusRail";
import { pct, price, rights as fmtRights, shortHash, usd } from "../format";
import { Icon, Prov } from "../ui";

/** Sub-dollar amounts get 3 decimals so rounding never overstates a small result. */
const heroDp = (v: bigint) => (v > -1_000_000n && v < 1_000_000n ? 3 : 2);

/* ------------------------------------------------------------ pending request */
export function IntentCard({ intent, onDismiss }: { intent: IntentState; onDismiss: () => void }) {
  const terminal = TERMINAL_INTENT.has(intent.status);
  const bad = ["CAPACITY_UNAVAILABLE", "EXPIRED", "REJECTED", "CANCELLED"].includes(intent.status);

  // Deliberately one in-flight state: matching vs house routing is decided behind "Opening…".
  return (
    <section className="card rise" aria-live="polite" aria-labelledby="intent-title">
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden className={terminal ? undefined : "spin"}>
          <circle cx="24" cy="24" r="19" stroke="var(--line-strong)" strokeWidth="3" fill="none" />
          {!terminal && <circle cx="24" cy="24" r="19" stroke="var(--monad-ink)" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeDasharray="30 200" />}
          {bad && <text x="24" y="30" textAnchor="middle" fill="var(--bad)" fontFamily="var(--font-jet)" fontSize="16">×</text>}
        </svg>
        <div style={{ flex: 1 }}>
          <h2 id="intent-title" style={{ margin: 0, fontSize: 18 }}>{INTENT_COPY[intent.status]}</h2>
          <p className="note" style={{ margin: "2px 0 0" }}>
            {intent.draft.side === "LONG" ? "Long" : "Short"} · {usd(intent.draft.collateral)} × {intent.draft.leverage}
          </p>
        </div>
      </div>
      {bad && intent.reason && <p className="warn-box" style={{ marginBottom: 0 }}>{intent.reason}</p>}
      {terminal && <button className="btn small" style={{ marginTop: 10 }} onClick={onDismiss}>Dismiss</button>}
    </section>
  );
}

/* --------------------------------------------------------------- open position */
export function PositionCard({ position: p, snap, params, closing }: { position: Position; snap: PriceSnapshot | undefined; params: ProtocolParams; closing?: boolean }) {
  const s = useServices();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mark = snap?.reference?.price ?? snap?.estimate;
  const demo = s.mode === "demo";

  let gross = 0n, fee = 0n, capped = false, dist = 0;
  if (mark) {
    const r = cappedGrossPnl(p, mark);
    gross = r.gross; capped = r.capped;
    fee = profitFee(gross, p.feeBps);
    dist = distanceToLiqBps(p, mark);
  }
  const net = gross - fee;
  const maxDist = Math.round((10_000 - params.maintenanceBps) / p.leverage);
  const health = Math.max(0, Math.min(1, dist / Math.max(1, maxDist * 2)));

  async function close() {
    setBusy(true); setErr(null);
    try { await s.positions.requestClose(p.id); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <section className="card rise" aria-labelledby="pos-title" style={{ borderColor: p.side === "LONG" ? "rgba(33,165,147,.5)" : "rgba(226,101,61,.5)" }}>
      <div className="card-title">
        <h2 id="pos-title">Open position</h2>
        <span style={{ display: "flex", gap: 6 }}>
          <span className="tag">{p.route === "HOUSE" ? "House-backed" : "Matched"}</span>
          <Prov p={p.provenance} demo={demo} />
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span className={`display ${p.side === "LONG" ? "up" : "down"}`} style={{ fontSize: 28 }}>{p.side === "LONG" ? "Long" : "Short"}</span>
        <span className="num dim">{usd(p.collateral)} × {p.leverage} = {usd(p.notional)}</span>
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="muted" style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>Estimated net P&amp;L <Prov p="ESTIMATE" /></div>
        <div className={`hero-num ${net > 0n ? "up" : net < 0n ? "down" : ""}`}>{usd(net, heroDp(net), true)}</div>
        <div className="note num">gross {usd(gross, 3, true)} · fee {usd(fee, 3)}{capped ? " · at cap" : ""}</div>
      </div>
      <div style={{ marginTop: 12 }} aria-label={`Distance to liquidation ${pct(dist, 3)}`}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }} className="muted">
          <span>Distance to liquidation</span><span className="num">{pct(dist, 3)}</span>
        </div>
        <div style={{ height: 8, borderRadius: 99, background: "var(--board)", border: "1px solid var(--line)", overflow: "hidden", marginTop: 4 }}>
          <div style={{ width: `${health * 100}%`, height: "100%", background: health < 0.25 ? "var(--bad)" : health < 0.5 ? "var(--warn)" : "var(--chalk-2)", transition: "width .3s" }} />
        </div>
      </div>
      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Entry</dt><dd>{price(p.entryPrice)}</dd>
        <dt>Liquidation</dt><dd>{price(p.liquidationPrice)}</dd>
        <dt>Mark (settlement reference)</dt><dd>{mark ? price(mark) : "—"}</dd>
        {p.route === "HOUSE" && <><dt>House reservation</dt><dd>{usd(p.houseReservation)}</dd></>}
        {p.route === "MATCHED" && <><dt>Max gross win</dt><dd>{usd(p.matchedMaxGrossWin)}</dd></>}
        <dt>Counterparty</dt><dd style={{ fontFamily: "var(--font-body)" }}>{p.counterpartyLabel ?? "—"}</dd>
        {p.openTx && <><dt>Open tx</dt><dd>{shortHash(p.openTx)}</dd></>}
      </dl>
      <details className="explain">
        <summary>When this can close without you</summary>
        <ul>
          <li>Liquidation if the reference price reaches {price(p.liquidationPrice)}.</li>
          {p.route === "MATCHED" && <li>Your counterparty can close at any time; that settles your side at the same price. If their margin is exhausted, your win stops there.</li>}
          {p.route === "HOUSE" && <li>Reserve protection: if your gain nears the {usd(p.houseReservation)} reservation and the house cannot reserve more, the position is closed early at the reference price.</li>}
          <li>Emergency or wind-down settlement under the published protocol states.</li>
        </ul>
      </details>
      {err && <p className="err-box" role="alert">{err}</p>}
      <button className="btn primary block" style={{ marginTop: 14 }} onClick={close} disabled={busy || closing}>
        {busy || closing ? "Closing…" : `Close at ~${mark ? price(mark) : "market"}`}
      </button>
      <p className="note" style={{ marginBottom: 0 }}>Final P&amp;L is set by the contract at the verified settlement price and may differ from this estimate.</p>
    </section>
  );
}

/* ------------------------------------------------------------------ settlement */
export function SettlementCard({ s, onDone }: { s: Settlement; onDone: () => void }) {
  const svc = useServices();
  const win = s.netPnl > 0n;
  const flat = s.netPnl === 0n;
  return (
    <section className="card rise" aria-live="assertive" aria-labelledby="settle-title">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {win && <span className="up"><Icon.tick /></span>}
        <div>
          <h2 id="settle-title" style={{ margin: 0, fontSize: 18 }}>
            {win ? "Closed with a net gain" : flat ? "Closed flat" : s.returned === 0n ? "Closed — margin lost" : "Closed with a loss"}
          </h2>
          <p className="note" style={{ margin: 0 }}>{s.route === "HOUSE" ? "House-backed" : "Matched"} · {reasonText(s.reason)}</p>
        </div>
      </div>
      <div className={`hero-num ${win ? "up" : flat ? "" : "down"}`} style={{ marginTop: 10 }}>{usd(s.netPnl, heroDp(s.netPnl), true)}</div>
      <dl className="kv" style={{ marginTop: 8 }}>
        <dt>Entry → exit</dt><dd>{price(s.entryPrice)} → {price(s.exitPrice)}</dd>
        <dt>Gross P&amp;L</dt><dd>{usd(s.grossPnl, 3, true)}</dd>
        {s.fee > 0n && <><dt>Fee ({pct(2500, 0)} of profit)</dt><dd>−{usd(s.fee, 3)}</dd></>}
        <dt>Returned to free balance</dt><dd>{usd(s.returned, 3)}</dd>
        {s.capped && <><dt>Capped</dt><dd style={{ fontFamily: "var(--font-body)" }}>{s.grossPnl < 0n ? "loss limited to your margin" : s.route === "MATCHED" ? "at counterparty margin" : "at house reservation"}</dd></>}
      </dl>
      {s.reason === "COUNTERPARTY" && <p className="note">Your counterparty closed, which settled your side at the same price.</p>}
      {s.rightsIssued > 0n && (
        <p className="warn-box" style={{ marginTop: 10 }}>
          This house-trade loss issued <strong className="num">{fmtRights(s.rightsIssued)}</strong> pending {brand.rightsName}. They are not a refund,
          can&apos;t be sold or redeemed for principal, activate next epoch, and may never earn anything.
        </p>
      )}
      <div className="sides" style={{ marginTop: 12 }}>
        <button className="btn" onClick={onDone}>Done</button>
      </div>
      {svc.mode === "demo" && <p className="note" style={{ marginBottom: 0 }}>Demo settlement: computed by the local engine, not a contract.</p>}
    </section>
  );
}
