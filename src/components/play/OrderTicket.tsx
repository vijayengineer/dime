"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProtocolParams } from "@/config/protocol";
import { parseUnits } from "@/domain/fixed";
import { exampleNetProfit, notionalOf } from "@/domain/math";
import type { Balances, OrderDraft, ProtocolState, Quote, Side } from "@/domain/types";
import { record } from "@/state/metrics";
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
  const [side, setSide] = useState<Side | null>(null);
  const [margin, setMargin] = useState<bigint>(marginChips[0] ?? params.minMargin);
  const [leverage, setLeverage] = useState(100);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  // Route, match window and price tolerance are auto-selected by the backend (shared/execution.ts)
  // and returned in the quote; the user authorises them on the review sheet.
  const draft: OrderDraft | null = side ? {
    side, collateral: margin, leverage, routes: { matched: true, houseFallback: true }, matchWindowMs: 0, slippageBps: 0,
  } : null;

  // Debounced indicative quote; refresh every 5s while a side is chosen.
  const key = draft ? `${side}|${margin}|${leverage}` : "";
  useEffect(() => {
    if (!draft) { setQuote(null); onPreview(null); return; }
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
  const ex = exampleNetProfit(margin, leverage, 0.05, params.profitFeeBps);
  const free = balances?.free ?? 0n;
  const blockers: string[] = [];
  if (!signedIn) blockers.push("Sign in to trade.");
  else if (!access.canTrade) blockers.push("Join the live test (invite code + terms) to trade.");
  else if (free < margin) blockers.push(`You need ${usd(margin)} free. Fund your account first.`);
  if (state !== "OPEN") blockers.push(`Protocol is ${state.replace("_", " ")}: new positions are paused.`);
  if (!priceOk) blockers.push("Price checks are failing, so new positions are paused.");

  const logLev = Math.log(leverage) / Math.log(params.maxLeverage);

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
            <button key={m.toString()} className="chip" aria-pressed={margin === m} onClick={() => setMargin(m)}>{usd(m)}</button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="lev"><span>Leverage</span><span className="num" style={{ color: "var(--chalk)", fontSize: 18 }}>{leverage}×</span></label>
        <input
          id="lev" type="range" min={0} max={1000} step={1} value={Math.round(logLev * 1000)}
          aria-valuetext={`${leverage} times`}
          onChange={(e) => {
            const v = Math.round(Math.pow(params.maxLeverage, Number(e.target.value) / 1000));
            setLeverage(Math.min(params.maxLeverage, Math.max(1, v)));
          }}
        />
        <div className="chips" role="group" aria-label="Leverage presets">
          {LEVERAGE_CHIPS.filter((l) => l <= params.maxLeverage).map((l) => (
            <button key={l} className="chip" aria-pressed={leverage === l} onClick={() => setLeverage(l)}>{l}×</button>
          ))}
        </div>
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
      </dl>

      <CapacityLine quote={quote} err={quoteErr} />

      <details className="explain">
        <summary>How execution works</summary>
        <ul>
          <li><strong>Matched:</strong> another trader takes the opposite side at the same verified price. Your profit comes from their margin, so it cannot exceed their margin{params.matchedGapBackstop > 0n ? ` plus a ${usd(params.matchedGapBackstop)} house backstop` : ""}. If either of you closes, both positions settle.</li>
          <li><strong>House:</strong> the house reserve is your counterparty. There is no fixed profit ceiling, but the house reserves {params.houseReservationMultiple}× your margin for you and may close the position early if your gain nears that and more cannot be reserved.</li>
          <li>Requests are whole-ticket: no partial fills, no splitting, never matched against your own wallet. Address checks cannot prevent coordinated multi-wallet trading.</li>
          <li>A pending request is not a position. If nothing opens before the window ends, it expires and your margin is free again.</li>
          <li>Execution is automatic: route, match window and price tolerance are chosen for you (tolerance stays inside ¼ of the liquidation distance) and shown before you sign.</li>
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
  if (!quote) return null;
  return (
    <div className="route" style={{ marginTop: 12 }}>
      <Icon.match />
      <div style={{ flex: 1 }}>
        <div><strong>Auto execution</strong></div>
        <div className="dim">{quote.executionSummary ?? "Matched first, then the house."}</div>
      </div>
      <Prov p="ESTIMATE" />
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
        <dt>Execution</dt><dd style={{ fontFamily: "var(--font-body)" }}>{!d.routes.matched ? "House, instant" : `Match only · ${d.matchWindowMs / 1000}s`}</dd>
        <dt>Price tolerance</dt><dd>{pct(d.slippageBps, 2)}</dd>
        <dt>Request expires</dt><dd>{params.intentTtlMs / 1000}s after signing</dd>
      </dl>
      <div className="chalk-rule" />
      <ul className="note" style={{ paddingLeft: 18, display: "grid", gap: 6 }}>
        {d.routes.matched && <li>If matched, your counterparty can close at any time, which settles your position too. Your win is capped at their margin{params.matchedGapBackstop > 0n ? " plus the reserved backstop" : ""}.</li>}
        {d.routes.houseFallback && <li>If backed by the house, it may be closed early under disclosed reserve-protection rules. Finite reserves cannot guarantee every payout.</li>}
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
