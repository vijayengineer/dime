"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProtocolParams } from "@/config/protocol";
import { parseUnits } from "@/domain/fixed";
import { exampleNetProfit, notionalOf } from "@/domain/math";
import type { Balances, OrderDraft, ProtocolState, Quote, Side } from "@/domain/types";
import { record } from "@/state/metrics";
import { maxLeverageFor } from "@shared/execution";
import { useApp } from "@/state/app";
import { useServices } from "@/state/services";
import { useAccess } from "../AccessGate";
import { pct, price, usd } from "../format";
import { Icon, Prov, Sheet } from "../ui";

const LEVERAGE_CHIPS = [10, 50, 100, 250, 500, 1000];

export function OrderTicket({
  params, balances, state, priceOk, signedIn, onPreview, onNeedFunds,
}: {
  params: ProtocolParams; balances: Balances | undefined; state: ProtocolState; priceOk: boolean; signedIn: boolean;
  onPreview: (q: Quote | null) => void; onNeedFunds: () => void;
}) {
  const s = useServices();
  const access = useAccess();
  const marginChips = useMemo(
    () => ["0.10", "0.25", "0.50", "1.00"].map((x) => parseUnits(x, params.collateralDecimals)).filter((x) => x >= params.minMargin && x <= params.maxMargin),
    [params],
  );
  const { house } = useApp();
  // House first: a house trade reserves houseReservationMultiple × margin, so the largest margin the house can take
  // right now is its free capacity / that multiple (and only while a house slot is open). Bigger sizes aren't offered.
  const houseMax = useMemo(() => {
    if (house.status !== "ok") return null;
    const h = house.value;
    if (h.openHousePositions >= params.maxConcurrentHousePositions) return 0n;
    return h.availableCapacity / BigInt(Math.max(1, params.houseReservationMultiple));
  }, [house, params.maxConcurrentHousePositions, params.houseReservationMultiple]);
  const fits = (m: bigint) => houseMax === null || m <= houseMax;
  const [side, setSide] = useState<Side | null>(null);
  const [margin, setMargin] = useState<bigint>(marginChips[0] ?? params.minMargin);
  const [leverage, setLeverage] = useState(100);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  // Keep the chosen margin inside what the house can take as its capacity moves.
  useEffect(() => {
    if (fits(margin)) return;
    const best = [...marginChips].reverse().find(fits);
    if (best !== undefined) setMargin(best);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [houseMax]);
  const houseFull = houseMax !== null && houseMax < params.minMargin;
  // $100 exposure cap: bigger margins get less leverage ($0.10 → 1000×, $1 → 100×).
  const levCap = maxLeverageFor(margin, params.maxLeverage);
  useEffect(() => { if (leverage > levCap) setLeverage(levCap); }, [levCap, leverage]);

  // Route, match window and price tolerance are auto-selected by the backend (shared/execution.ts)
  // and returned in the quote; the user authorises them on the review sheet.
  const draft: OrderDraft | null = side ? {
    side, collateral: margin, leverage, routes: { matched: true, houseFallback: true }, matchWindowMs: 0, slippageBps: 0,
  } : null;

  // Debounced indicative quote; refresh every 5s while a side is chosen. Quotes need a session, so none while signed out.
  const key = draft && signedIn ? `${side}|${margin}|${leverage}` : "";
  useEffect(() => {
    if (!draft || !signedIn) { setQuote(null); setQuoteErr(null); onPreview(null); return; }
    let cancelled = false;
    const get = async () => {
      try {
        const q = await s.intents.quote(draft);
        record("quoteLatencyMs", q.latencyMs);
        if (!cancelled) { setQuote(q); setQuoteErr(null); onPreview(q); }
      } catch (e) { if (!cancelled) { setQuoteErr((e as Error).message); setQuote(null); onPreview(null); } }
    };
    const t = setTimeout(get, 200);
    const iv = setInterval(get, 5000);
    return () => { cancelled = true; clearTimeout(t); clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, s]);

  useEffect(() => () => onPreview(null), [onPreview]);

  const notional = notionalOf(margin, leverage);
  // The house pays at most its reservation for this trade (audit M-09): shown before signing.
  const winCapGross = margin * BigInt(params.houseReservationMultiple);
  const winCapNet = winCapGross - (winCapGross * BigInt(params.profitFeeBps) + 9_999n) / 10_000n;
  const ex = exampleNetProfit(margin, leverage, 0.05, params.profitFeeBps);
  const free = balances?.free ?? 0n;
  const blockers: string[] = [];
  if (!signedIn) blockers.push("Sign in to trade.");
  else if (!access.canTrade) blockers.push("Join the live test (invite code + terms) to trade.");
  else if (free < margin) blockers.push(`You need ${usd(margin)} free. Fund your account first.`);
  if (houseFull) blockers.push("The house is full right now. New trades open again as positions close.");
  else if (quote && !quote.capacity.houseAvailable) blockers.push("The house can't take this trade right now. Try a smaller margin or the other side.");
  if (state !== "OPEN") blockers.push(`Protocol is ${state.replace("_", " ")}: new positions are paused.`);
  if (!priceOk) blockers.push("Price checks are failing, so new positions are paused.");

  const logLev = Math.log(leverage) / Math.log(Math.max(2, levCap));

  return (
    <section className="card" aria-labelledby="ticket-title">
      <div className="card-title"><h2 id="ticket-title">New position</h2><span className="tag">BTC · isolated</span></div>

      <div className="sides" role="group" aria-label="Direction">
        <button className="side-btn long" aria-pressed={side === "LONG"} onClick={() => setSide("LONG")}>
          <span className="display">Long</span><small>BTC goes up</small><Icon.up />
        </button>
        <button className="side-btn short" aria-pressed={side === "SHORT"} onClick={() => setSide("SHORT")}>
          <span className="display">Short</span><small>BTC goes down</small><Icon.down />
        </button>
      </div>

      <div className="field">
        <span className="label" id="margin-l"><span>Margin</span><span className="num muted">free {usd(free)}</span></span>
        <div className="chips" role="group" aria-labelledby="margin-l">
          {marginChips.map((m) => (
            <button key={m.toString()} className="chip" aria-pressed={margin === m} disabled={!fits(m)} onClick={() => setMargin(m)}>{usd(m)}</button>
          ))}
        </div>
        {houseMax !== null && !houseFull && marginChips.some((m) => !fits(m)) && (
          <p className="note" style={{ margin: "6px 0 0" }}>The house can take up to {usd(houseMax)} margin right now.</p>
        )}
      </div>

      <div className="field">
        <label htmlFor="lev"><span>Leverage</span><span className="num" style={{ color: "var(--chalk)", fontSize: 18 }}>{leverage}×</span></label>
        <input
          id="lev" type="range" min={0} max={1000} step={1} value={Math.round(logLev * 1000)}
          aria-valuetext={`${leverage} times`}
          onChange={(e) => {
            const v = Math.round(Math.pow(Math.max(2, levCap), Number(e.target.value) / 1000));
            setLeverage(Math.min(levCap, Math.max(1, v)));
          }}
        />
        <div className="chips" role="group" aria-label="Leverage presets">
          {[...LEVERAGE_CHIPS.filter((l) => l < levCap), levCap].map((l) => (
            <button key={l} className="chip" aria-pressed={leverage === l} onClick={() => setLeverage(l)}>{l}×</button>
          ))}
        </div>
        {levCap < params.maxLeverage && (
          <p className="note" style={{ margin: "6px 0 0" }}>Up to {levCap}× at {usd(margin)}: every trade is capped at $100 of BTC.</p>
        )}
      </div>

      <div className="chalk-rule" />

      <dl className="kv">
        <dt>Gross exposure</dt><dd>{usd(notional)}</dd>
        <dt>Liquidation price <Prov p="ESTIMATE" /></dt>
        <dd>{quote ? price(quote.liquidationPrice) : "—"}</dd>
        <dt>If BTC moves 0.05% your way</dt>
        <dd className="up">{usd(ex.net, 3, true)} <span className="muted">net</span></dd>
        <dt className="muted" style={{ fontSize: 12.5 }}>after {pct(params.profitFeeBps, 0)} fee on profit</dt>
        <dd className="muted" style={{ fontSize: 12.5 }}>fee {usd(ex.fee, 3)}</dd>
        <dt>Max loss</dt><dd>{usd(margin)} <span className="muted">(your margin)</span></dd>
        <dt>Max win</dt><dd>{usd(winCapNet)} <span className="muted">net, unless the house reserves more</span></dd>
      </dl>

      <CapacityLine quote={quote} err={quoteErr} />

      <details className="explain">
        <summary>How execution works</summary>
        <ul>
          <li><strong>The house fills you instantly.</strong> The house reserve takes the other side at the verified price as soon as you sign.</li>
          <li><strong>Your win is capped.</strong> For each trade the house sets aside {params.houseReservationMultiple}× your margin ({usd(winCapGross)} gross, {usd(winCapNet)} after the fee). That is the most a settlement pays. When your gain nears it, the keeper tries to reserve another {params.houseReservationMultiple}× from free capacity; if there isn&apos;t any, your position is closed early at the verified price and paid in full up to the cap.</li>
          <li>The biggest margin on offer depends on how much of the reserve is free.</li>
          <li>Your margin is the most you can lose. Whole tickets only: no partial fills.</li>
          <li>Price tolerance is set for you (inside ¼ of the liquidation distance) and shown before you sign. If the price moves past it, nothing opens and your margin stays free.</li>
        </ul>
      </details>

      {blockers.length > 0 && (
        <div className="warn-box" style={{ marginTop: 12 }}>
          {blockers.map((b) => <div key={b}>{b}</div>)}
          {signedIn && !access.canTrade && <button className="btn small" style={{ marginTop: 8 }} onClick={access.openJoin}>Join with invite code</button>}
          {signedIn && access.canTrade && free < margin && <button className="btn small" style={{ marginTop: 8 }} onClick={onNeedFunds}>Fund account</button>}
        </div>
      )}

      {signedIn ? (
        <button className="btn primary block" style={{ marginTop: 14 }} disabled={!quote || blockers.length > 0} onClick={() => setReviewing(true)}>
          {side ? `Review ${side.toLowerCase()}` : "Choose long or short"}
        </button>
      ) : (
        <button className="btn primary block" style={{ marginTop: 14 }} onClick={() => s.wallet.login()}>Sign in to trade</button>
      )}

      {quote && <ReviewSheet open={reviewing} onClose={() => setReviewing(false)} quote={quote} params={params} />}
    </section>
  );
}

function CapacityLine({ quote, err }: { quote: Quote | null; err: string | null }) {
  if (err) return <p className="err-box" style={{ marginTop: 12 }} role="alert">Quote unavailable: {err}</p>;
  // Only the instant house fill is offered here; when the house can't take a trade the blockers say so.
  if (!quote || !quote.capacity.houseAvailable) return null;
  return (
    <div className="route" style={{ marginTop: 12 }}>
      <Icon.match />
      <div style={{ flex: 1 }}>
        <div><strong>Instant fill</strong></div>
        <div className="dim">The house takes the other side straight away.</div>
      </div>
    </div>
  );
}

function ReviewSheet({ open, onClose, quote, params }: { open: boolean; onClose: () => void; quote: Quote; params: ProtocolParams }) {
  const s = useServices();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = quote.draft;
  const expired = Date.now() > quote.expiresAt;

  async function submit() {
    setBusy(true); setErr(null);
    try { await s.intents.submit(quote); onClose(); setAck(false); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Sheet open={open} onClose={onClose} labelledBy="review-title">
      <h2 id="review-title" className={d.side === "LONG" ? "up" : "down"}>{d.side === "LONG" ? "Long" : "Short"} BTC</h2>
      <p className="note">You are signing a request, not opening a position. It is bound to this chain, contract, your wallet, BTC, these terms, config v{quote.configVersion}, an expiry and a one-time nonce.</p>
      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Margin (max loss)</dt><dd>{usd(d.collateral)}</dd>
        <dt>Leverage · gross exposure</dt><dd>{d.leverage}× · {usd(quote.notional)}</dd>
        <dt>Indicative entry <Prov p="ESTIMATE" /></dt><dd>{price(quote.indicativeEntry)}</dd>
        <dt>Worst accepted entry</dt><dd>{price(quote.priceLimit)}</dd>
        <dt>Liquidation near</dt><dd>{price(quote.liquidationPrice)}</dd>
        <dt>Fee</dt><dd>{pct(quote.feeBps, 0)} of positive P&amp;L</dd>
        {!d.routes.matched && (() => {
          const g = d.collateral * BigInt(params.houseReservationMultiple);
          const n = g - (g * BigInt(quote.feeBps) + 9_999n) / 10_000n;
          return <><dt>Max win</dt><dd>{usd(n)} net <span className="muted">({usd(g)} gross)</span></dd></>;
        })()}
        <dt>Execution</dt><dd style={{ fontFamily: "var(--font-body)" }}>{!d.routes.matched ? "House, instant" : `Match only · ${d.matchWindowMs / 1000}s`}</dd>
        <dt>Price tolerance</dt><dd>{pct(d.slippageBps, 2)}</dd>
        <dt>Request expires</dt><dd>{params.intentTtlMs / 1000}s after signing</dd>
      </dl>
      <div className="chalk-rule" />
      <ul className="note" style={{ paddingLeft: 18, display: "grid", gap: 6 }}>
        {d.routes.matched && <li>If matched, your counterparty can close at any time, which settles your position too. Your win is capped at their margin{params.matchedGapBackstop > 0n ? " plus the reserved backstop" : ""}.</li>}
        {d.routes.houseFallback && <li>Backed by the house: a settlement pays at most the amount reserved for you ({params.houseReservationMultiple}× your margin) unless more is reserved first. Near that cap the position may be closed early at the verified price. Finite reserves cannot guarantee every payout.</li>}
        <li>Your close settles at the verified price just after you ask, not at a price you pick.</li>
        <li>At {d.leverage}×, a {pct(Math.round(((10_000 - params.maintenanceBps) / d.leverage)), 3)} move against you liquidates the position and your margin is lost.</li>
        <li>Matched and house routes are not economically identical.</li>
      </ul>
      <label className="toggle" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I understand I can lose my full {usd(d.collateral)} margin, and how early closure works on {d.routes.matched && d.routes.houseFallback ? "both routes" : "this route"}.</span>
      </label>
      {expired && <p className="warn-box">This quote expired. Close and review again.</p>}
      {err && <p className="err-box" role="alert">{err}</p>}
      <div className="sides" style={{ marginTop: 14 }}>
        <button className="btn" onClick={onClose}>Back</button>
        <button className="btn primary" disabled={!ack || busy || expired} onClick={submit}>{busy ? "Signing…" : "Sign & submit"}</button>
      </div>
    </Sheet>
  );
}
