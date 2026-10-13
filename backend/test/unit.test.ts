import { describe, expect, it } from "vitest";
import { Aggregator } from "../src/pricing/aggregate";
import { parsePrice } from "../src/pricing/decimal";
import { Store, type IntentRow } from "../src/store/db";
import { Matcher, reasonFor } from "../src/matching/matcher";
import type { TxResult } from "../src/chain/executor";

const P = (s: string) => parsePrice(s);

describe("price parsing", () => {
  it("is exact to 8 decimals without floats", () => {
    expect(P("82595.66")).toBe(8_259_566_000_000n);
    expect(P("0.00000001")).toBe(1n);
    expect(P("100000.123456789")).toBe(10_000_012_345_678n); // truncates beyond 8dp
  });
});

describe("fair-value aggregator", () => {
  const base = { maxAgeMs: 2000, maxDisagreementBps: 15, minSources: 2 };
  const tick = (id: string, quote: "USD" | "USDT", price: string, at: number, seq = 1) => ({ id, name: id, quote, price: P(price), ts: at, recvAt: at, seq });

  it("takes the median of fresh USD sources", () => {
    const a = new Aggregator(base);
    a.update(tick("a", "USD", "100000", 1000));
    a.update(tick("b", "USD", "100010", 1000));
    a.update(tick("c", "USD", "100004", 1000));
    const e = a.compute(1500)!;
    expect(e.estimate).toBe(P("100004"));
    expect(e.quality).toBe("OK");
  });

  it("applies the measured USD−USDT basis to USDT venues", () => {
    const a = new Aggregator(base);
    a.update(tick("usd1", "USD", "100000", 1000));
    a.update(tick("usdt1", "USDT", "100100", 1000));
    const e = a.compute(1100)!;
    expect(e.basis.USDT).toBe(-P("100"));
    expect(e.estimate).toBe(P("100000")); // both now agree after basis
  });

  it("flags stale and conflicting inputs instead of guessing", () => {
    const a = new Aggregator(base);
    a.update(tick("a", "USD", "100000", 1000));
    a.update(tick("b", "USD", "100000", 1000));
    expect(a.compute(5000)!.quality).toBe("STALE");
    const b = new Aggregator(base);
    b.update(tick("a", "USD", "100000", 1000));
    b.update(tick("b", "USD", "100300", 1000)); // 30 bps apart
    expect(b.compute(1100)!.quality).toBe("CONFLICT");
  });

  it("drops out-of-order ticks", () => {
    const a = new Aggregator(base);
    expect(a.update(tick("a", "USD", "100000", 2000, 5))).toBe(true);
    expect(a.update(tick("a", "USD", "90000", 1000, 4))).toBe(false);
  });
});

describe("matcher", () => {
  function setup(opts: { proof?: boolean; elig?: (r: IntentRow) => string | null; exec?: Partial<{ m: TxResult; h: TxResult }> } = {}) {
    const store = new Store(":memory:");
    let now = 1_000_000;
    const calls: string[] = [];
    const ok: TxResult = { txId: "t", status: "INCLUDED", hash: "0xabc", block: 1 };
    const m = new Matcher(
      store,
      { freshProof: () => (opts.proof === false ? null : { price: P("100000").toString(), tsMs: now, payload: "0x01" }) },
      {
        openMatched: async (l, s) => { calls.push(`M:${l.user}/${s.user}`); return opts.exec?.m ?? ok; },
        openHouse: async (r) => { calls.push(`H:${r.user}`); return opts.exec?.h ?? ok; },
      },
      { check: async (r) => opts.elig?.(r) ?? null },
      () => {},
      { maxQueuePerBucket: 2, proofMaxAgeMs: 2000, submitMarginMs: 1000, houseAfterDeadlineMs: 1000, positionIdFor: () => "0xpos" },
      () => now,
    );
    let n = 0;
    const add = async (user: string, side: 0 | 1, mask: number, lev = 1000) => {
      const row: IntentRow = {
        id: `i${++n}`, user, nonce: String(n), status: mask & 1 ? "MATCHING" : "SUBMITTED", side, collateral: "100000", leverage: lev,
        route_mask: mask, match_deadline: Math.floor(now / 1000) + 5, expiry: Math.floor(now / 1000) + 30,
        price_limit: side === 0 ? P("200000").toString() : "1", config_version: 1, match_window_ms: 5000, slippage_bps: 2,
        message: "{}", signature: "0x", route: mask & 1 ? null : "HOUSE", reason: null, tx_id: null, position_id: null,
        timeline: "[]", created_at: now, updated_at: now,
      };
      store.insertIntent(row);
      await m.onNew(row);
      return row.id;
    };
    return { store, m, add, calls, advance: (ms: number) => { now += ms; } };
  }

  it("pairs opposite equal tickets FIFO and opens atomically", async () => {
    const t = setup();
    const a = await t.add("alice", 0, 1);
    const b = await t.add("bob", 1, 1);
    expect(t.calls).toEqual(["M:alice/bob"]);
    expect(t.store.getIntent(a)!.status).toBe("OPENED");
    expect(t.store.getIntent(b)!.route).toBe("MATCHED");
  });

  it("never self-matches and never matches different sizes", async () => {
    const t = setup();
    await t.add("alice", 0, 1);
    await t.add("alice", 1, 1);
    await t.add("bob", 1, 1, 500);
    expect(t.calls).toEqual([]);
  });

  it("falls back to the house only after the window and only if authorised", async () => {
    const t = setup();
    const a = await t.add("alice", 0, 3);
    const b = await t.add("bob", 0, 1);
    t.advance(5000); await t.m.tick();
    expect(t.calls).toEqual([]); // still inside deadline + safety margin
    t.advance(1500); await t.m.tick();
    expect(t.calls).toEqual(["H:alice"]);
    expect(t.store.getIntent(a)!.status).toBe("OPENED");
    expect(t.store.getIntent(b)!.status).toBe("EXPIRED");
  });

  it("an ineligible counterparty does not take down the other side", async () => {
    const t = setup({ elig: (r) => (r.user === "bob" ? "Not enough free balance." : null) });
    const a = await t.add("alice", 0, 1);
    const b = await t.add("bob", 1, 1);
    expect(t.store.getIntent(b)!.status).toBe("REJECTED");
    expect(t.store.getIntent(a)!.status).toBe("MATCHING");
  });

  it("maps contract reverts to user-facing states", async () => {
    expect(reasonFor("CapacityUnavailable").status).toBe("CAPACITY_UNAVAILABLE");
    expect(reasonFor("PriceLimit").status).toBe("REJECTED");
    expect(reasonFor("MatchWindow").status).toBe("EXPIRED");
    const t = setup({ exec: { h: { txId: "t", status: "FAILED", revert: "CapacityUnavailable" } } });
    const a = await t.add("alice", 0, 2);
    expect(t.store.getIntent(a)!.status).toBe("CAPACITY_UNAVAILABLE");
  });

  it("does not execute without a fresh verified price", async () => {
    const t = setup({ proof: false });
    await t.add("alice", 0, 1);
    await t.add("bob", 1, 1);
    expect(t.calls).toEqual([]);
  });

  it("bounds the queue per bucket", async () => {
    const t = setup();
    await t.add("a1", 0, 1);
    await t.add("a2", 0, 1);
    expect(t.m.canAdmit({ collateral: "100000", leverage: 1000 })).toBe(false);
  });
});

import { capWeights, microprice, weightedMedian } from "../src/pricing/aggregate";

describe("fair-value v2 maths", () => {
  it("microprice leans toward the thin side", () => {
    // big bid, small ask ⇒ price likely to tick up ⇒ microprice near the ask
    const m = microprice({ bid: P("100000"), ask: P("100001"), bidSize: P("9"), askSize: P("1"), price: P("100000.5") });
    expect(m).toBe(P("100000.9"));
    expect(microprice({ bid: P("1"), ask: P("3"), price: P("2") })).toBe(P("2")); // no sizes → mid
  });

  it("weighted median follows liquidity, not venue count", () => {
    const wm = weightedMedian([
      { price: P("100000"), weight: 0.6 }, { price: P("100010"), weight: 0.2 }, { price: P("100020"), weight: 0.2 },
    ]);
    expect(wm).toBe(P("100000"));
  });

  it("caps any single venue's share and redistributes", () => {
    const w = capWeights([90, 5, 5], 0.4);
    expect(Math.max(...w)).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("one bad venue cannot move the estimate", () => {
    const a = new Aggregator({ maxAgeMs: 2000, maxDisagreementBps: 1000, minSources: 2 });
    const t = (id: string, px: string) => ({ id, name: id, quote: "USD" as const, price: P(px), bid: P(px) - 100n, ask: P(px) + 100n, bidSize: P("1"), askSize: P("1"), ts: 1000, recvAt: 1000, seq: 1 });
    a.update(t("a", "100000")); a.update(t("b", "100001")); a.update(t("c", "100002")); a.update(t("bad", "90000"));
    const e = a.compute(1100)!;
    expect(e.estimate >= P("100000") && e.estimate <= P("100002")).toBe(true);
    expect(e.quality).toBe("CONFLICT"); // still flagged: sources disagree by >10%
  });

  it("aligns a perp venue with a measured basis and weights fresher data more", () => {
    const a = new Aggregator({ maxAgeMs: 2000, maxDisagreementBps: 15, minSources: 2 });
    a.update({ id: "spot", name: "s", quote: "USD", price: P("100000"), ts: 1000, recvAt: 1000, seq: 1 });
    a.update({ id: "perp", name: "p", quote: "USDC_PERP", price: P("100050"), ts: 1000, recvAt: 1000, seq: 1 });
    const e = a.compute(1000)!;
    expect(e.basis.USDC_PERP).toBe(-P("50"));
    expect(e.estimate).toBe(P("100000"));
    const stale = a.compute(2900)!; // 1.9 s old of a 2 s max age
    expect(stale.venues.every((v) => v.freshness < 0.1)).toBe(true);
  });

  it("drops duplicates from a redundant connection", () => {
    const a = new Aggregator({ maxAgeMs: 2000, maxDisagreementBps: 15, minSources: 1 });
    const t = { id: "binance", name: "b", quote: "USDT" as const, price: P("100000"), ts: 1000, recvAt: 1000, seq: 42 };
    expect(a.update(t)).toBe(true);
    expect(a.update({ ...t, recvAt: 1003 })).toBe(false); // same update id from connection #2
  });
});

describe("matcher house fallback vs chain clock", () => {
  it("retries the fallback when the chain says the match window hasn't ended yet", async () => {
    const store = new Store(":memory:");
    let now = 1_000_000;
    let calls = 0;
    const m = new Matcher(
      store,
      { freshProof: () => ({ price: P("100000").toString(), tsMs: now, payload: "0x01" }) },
      {
        openMatched: async () => ({ txId: "t", status: "INCLUDED" }),
        openHouse: async () => (++calls === 1 ? { txId: "t", status: "FAILED", revert: "MatchWindow" } : { txId: "t", status: "INCLUDED", hash: "0xabc", block: 2 }),
      },
      { check: async () => null }, () => {},
      { maxQueuePerBucket: 10, proofMaxAgeMs: 2000, submitMarginMs: 1000, houseAfterDeadlineMs: 1000, positionIdFor: () => "0xpos" },
      () => now,
    );
    const row: IntentRow = {
      id: "h1", user: "alice", nonce: "1", status: "MATCHING", side: 0, collateral: "100000", leverage: 1000, route_mask: 3,
      match_deadline: Math.floor(now / 1000) + 2, expiry: Math.floor(now / 1000) + 30, price_limit: P("200000").toString(),
      config_version: 1, match_window_ms: 2000, slippage_bps: 2, message: "{}", signature: "0x", route: null, reason: null,
      tx_id: null, position_id: null, timeline: "[]", created_at: now, updated_at: now,
    };
    store.insertIntent(row);
    now += 3500; await m.tick();
    expect(store.getIntent("h1")!.status).toBe("MATCHING"); // put back, not expired
    now += 500; await m.tick();
    expect(store.getIntent("h1")!.status).toBe("OPENED");
    expect(calls).toBe(2);
  });
});

describe("degraded fallback (Hyperliquid only)", () => {
  const tk = (id: string, quote: "USD" | "USDT" | "USDC_PERP", px: string, at: number) =>
    ({ id, name: id, quote, price: P(px), bid: P(px) - 100n, ask: P(px) + 100n, bidSize: P("1"), askSize: P("1"), ts: at, recvAt: at, seq: at });

  it("uses Hyperliquid alone, basis-adjusted and flagged, when other venues go stale", () => {
    const a = new Aggregator({ maxAgeMs: 2000, maxDisagreementBps: 15, minSources: 2 });
    a.update(tk("coinbase", "USD", "100000", 1000));
    a.update(tk("hyperliquid", "USDC_PERP", "100050", 1000));
    expect(a.compute(1000)!.quality).toBe("OK"); // basis learned: perp −50
    a.update(tk("hyperliquid", "USDC_PERP", "100150", 4000)); // coinbase now stale
    const e = a.compute(4000)!;
    expect(e.quality).toBe("DEGRADED");
    expect(e.used).toEqual(["hyperliquid"]);
    expect(e.estimate).toBe(P("100100")); // 100150 − 50 basis
  });

  it("is INSUFFICIENT (not degraded) if Hyperliquid is stale too, or the fallback is disabled", () => {
    const a = new Aggregator({ maxAgeMs: 2000, maxDisagreementBps: 15, minSources: 2 });
    a.update(tk("binance", "USDT", "100000", 1000));
    a.update(tk("okx", "USDT", "100001", 1000));
    a.update(tk("binance", "USDT", "100000", 5000));
    expect(a.compute(5000)!.quality).toBe("INSUFFICIENT");
    const b = new Aggregator({ maxAgeMs: 2000, maxDisagreementBps: 15, minSources: 2, degradedFallback: null });
    b.update(tk("hyperliquid", "USDC_PERP", "100000", 1000));
    expect(b.compute(1000)!.quality).toBe("INSUFFICIENT");
  });
});
