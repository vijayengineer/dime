import { describe, expect, it } from "vitest";
import { Aggregator, type SourceTick } from "../src/pricing/aggregate";
import { parsePrice } from "../src/pricing/decimal";

/**
 * Security regressions for the October 2026 audit. Each asserts the FIXED behaviour, so it fails if the
 * audited behaviour comes back.
 */
const P = (s: string) => parsePrice(s);
const live = { maxAgeMs: 2000, maxDisagreementBps: 15, minSources: 3, maxWeightShare: 0.4 };
const t = (id: string, quote: SourceTick["quote"], px: string, at: number, seq = at, extra: Partial<SourceTick> = {}): SourceTick =>
  ({ id, name: id, quote, price: P(px), bid: P(px) - 100n, ask: P(px) + 100n, bidSize: P("1"), askSize: P("1"), ts: at, recvAt: at, seq, ...extra });

describe("audit H-02: one USD anchor cannot steer the other venues", () => {
  it("the audit's startup case — one USD venue at 100,100 and four honest others at 100,000 — is not an OK 100,100", () => {
    const a = new Aggregator(live);
    a.update(t("coinbase", "USD", "100100", 1000));
    for (const id of ["binance", "okx", "bybit"]) a.update(t(id, "USDT", "100000", 1000));
    a.update(t("hyperliquid", "USDC_PERP", "100000", 1000));
    const e = a.compute(1000)!;
    expect(e.quality === "OK" && e.estimate === P("100100")).toBe(false);
    expect(e.quality).not.toBe("OK"); // no independent anchor ⇒ no basis ⇒ no quorum
  });

  it("compute() is a pure snapshot: repeating it without new ticks changes nothing", () => {
    const a = new Aggregator(live);
    a.update(t("coinbase", "USD", "100000", 1000));
    a.update(t("kraken", "USD", "100000", 1000));
    a.update(t("binance", "USDT", "100050", 1000));
    a.update(t("coinbase", "USD", "100010", 1100));
    const first = a.compute(1200)!;
    const basis = a.basisState();
    for (let i = 0; i < 50; i++) a.compute(1200);
    const again = a.compute(1200)!;
    expect(again.estimate).toBe(first.estimate);
    expect(again.disagreementBps).toBe(first.disagreementBps);
    expect(a.basisState()).toEqual(basis);
  });

  it("a distorted anchor venue moves the basis by at most the per-step bound, and is flagged", () => {
    const a = new Aggregator({ ...live, maxBasisStepBps: 5, basisTauMs: 60_000 });
    a.update(t("coinbase", "USD", "100000", 1000));
    a.update(t("kraken", "USD", "100000", 1000));
    a.update(t("binance", "USDT", "100000", 1000));
    expect(a.basisState().basis.USDT).toBe(0n);
    // coinbase jumps +50 bps; the anchor no longer agrees ⇒ the basis is frozen and the price is a CONFLICT
    a.update(t("coinbase", "USD", "100500", 61_000));
    a.update(t("kraken", "USD", "100000", 61_000));
    a.update(t("binance", "USDT", "100000", 61_000));
    expect(a.basisState().basis.USDT).toBe(0n);
    expect(a.compute(61_000)!.quality).toBe("CONFLICT");
  });

  it("disagreement is assessed after adjustment too: a mis-set group cannot read as zero disagreement", () => {
    const a = new Aggregator(live);
    a.update(t("coinbase", "USD", "100000", 1000));
    a.update(t("kraken", "USD", "100002", 1000));
    a.update(t("binance", "USDT", "100000", 1000));
    a.update(t("okx", "USDT", "100400", 1000)); // 40 bps inside its own group
    const e = a.compute(1000)!;
    expect(e.rawDisagreementBps).toBeGreaterThan(15);
    expect(e.quality).toBe("CONFLICT");
  });
});

describe("audit H-03: freshness comes from the exchange, ordering is strict", () => {
  it("~100-second-old exchange data received now is stale, not OK", () => {
    const a = new Aggregator(live);
    const now = 200_000;
    for (const id of ["coinbase", "kraken", "bybit"]) a.update(t(id, "USD", "100000", now - 100_000, now - 100_000, { recvAt: now, hasSourceTs: true }));
    const e = a.compute(now)!;
    expect(e.quality).not.toBe("OK");
    expect(e.used).toEqual([]);
  });

  it("an older sequence (99 after 100) is dropped even when its receipt time is later", () => {
    const a = new Aggregator(live);
    expect(a.update(t("binance", "USDT", "100000", 1000, 100))).toBe(true);
    expect(a.update(t("binance", "USDT", "99000", 1200, 99))).toBe(false);
    expect(a.rejected.order).toBe(1);
  });

  it("an exchange timestamp going backwards is dropped even with a higher sequence", () => {
    const a = new Aggregator(live);
    expect(a.update(t("okx", "USDT", "100000", 2000, 10, { recvAt: 2010, hasSourceTs: true }))).toBe(true);
    expect(a.update(t("okx", "USDT", "99000", 1500, 11, { recvAt: 2020, hasSourceTs: true }))).toBe(false);
  });

  it("exchange timestamps far ahead of receipt are rejected as a clock fault", () => {
    const a = new Aggregator(live);
    expect(a.update(t("bybit", "USDT", "100000", 9000, 1, { recvAt: 1000, hasSourceTs: true }))).toBe(false);
    expect(a.rejected.skew).toBe(1);
  });

  it("a lower sequence is accepted only after a reconnect gap", () => {
    const a = new Aggregator(live);
    expect(a.update(t("bybit", "USDT", "100000", 1000, 500))).toBe(true);
    expect(a.update(t("bybit", "USDT", "100000", 1100, 1))).toBe(false); // too soon: not a reset
    expect(a.update(t("bybit", "USDT", "100000", 7000, 1))).toBe(true); // silent > 5 s: reconnect
  });

  it("the estimate reports its OLDEST observation (signed on-chain as obsMs)", () => {
    const a = new Aggregator(live);
    a.update(t("coinbase", "USD", "100000", 900, 1, { recvAt: 1000, hasSourceTs: true }));
    a.update(t("kraken", "USD", "100000", 1000));
    a.update(t("bybit", "USD", "100000", 950, 1, { recvAt: 1000, hasSourceTs: true }));
    expect(a.compute(1000)!.obsMs).toBe(900);
  });
});

describe("audit H-04: one or two venues never make an OK price", () => {
  it("Hyperliquid alone is DEGRADED (settlement only), never OK", () => {
    const a = new Aggregator(live);
    a.update(t("coinbase", "USD", "100000", 1000));
    a.update(t("kraken", "USD", "100000", 1000));
    a.update(t("hyperliquid", "USDC_PERP", "100050", 1000));
    expect(a.compute(1000)!.quality).toBe("OK");
    a.update(t("hyperliquid", "USDC_PERP", "100060", 4000));
    const e = a.compute(4000)!;
    expect(e.quality).toBe("DEGRADED");
    expect(e.used).toEqual(["hyperliquid"]);
  });

  it("two fresh venues are not a quorum (the 40% cap cannot hold with two)", () => {
    const a = new Aggregator(live);
    a.update(t("coinbase", "USD", "100000", 1000));
    a.update(t("kraken", "USD", "100000", 1000));
    expect(a.compute(1000)!.quality).not.toBe("OK");
  });

  it("with three or more venues no single venue carries more than 40%", () => {
    const a = new Aggregator(live);
    a.update({ ...t("coinbase", "USD", "100000", 1000), bidSize: P("100"), askSize: P("100") });
    a.update(t("kraken", "USD", "100001", 1000));
    a.update(t("bybit", "USD", "100002", 1000));
    const e = a.compute(1000)!;
    expect(e.quality).toBe("OK");
    expect(Math.max(...e.venues.map((v) => v.weight))).toBeLessThanOrEqual(0.4 + 1e-9);
  });
});

/* ------------------------------------------------------------------ backend reliability */
import Fastify from "fastify";
import { keccak256, type Hex } from "viem";
import { Store, type IntentRow } from "../src/store/db";
import { Executor } from "../src/chain/executor";
import { Matcher } from "../src/matching/matcher";
import { installAuthAndRateLimit } from "../src/api/limits";
import { EnvioIndexer } from "../src/indexer/envio";

const RAW = "0x02f8aa0182" as Hex;
function fakeChain(over: Partial<Record<string, unknown>> = {}) {
  const account = { address: "0x00000000000000000000000000000000000000aa" as Hex };
  const pub = {
    simulateContract: async () => ({ request: {} }),
    estimateContractGas: async () => 100_000n,
    getTransactionCount: async () => 7,
    sendRawTransaction: async () => keccak256(RAW),
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 10n }),
    getTransactionReceipt: async () => { throw new Error("not found"); },
    ...over,
  };
  const client = { account, prepareTransactionRequest: async (x: unknown) => x, signTransaction: async () => RAW };
  const abi = ["openHouse", "close"].map((name) => ({ type: "function", name, inputs: [], outputs: [], stateMutability: "nonpayable" }));
  return { chain: {}, pub, protocol: { address: "0x0000000000000000000000000000000000000001", abi }, wallet: () => ({ account, client }) } as never;
}

describe("audit M-03: an ambiguous broadcast is journalled and reconciled, never 'failed'", () => {
  it("RPC accepts but the response is lost → UNKNOWN with the hash and raw bytes stored; reconcile finds the receipt", async () => {
    const store = new Store(":memory:");
    let receipt = false;
    const c = fakeChain({
      sendRawTransaction: async () => { throw new Error("socket hang up"); },
      getTransactionReceipt: async () => { if (!receipt) throw new Error("not found"); return { status: "success", blockNumber: 11n }; },
    });
    const ex = new Executor(store, c, ("0x" + "11".repeat(32)) as Hex, "relayer");
    const resolved: string[] = [];
    ex.onResolved((t) => resolved.push(t.status));
    const r = await ex.submit("OPEN_HOUSE", "i1", "openHouse", []);
    expect(r.status).toBe("UNKNOWN");
    expect(r.hash).toBe(keccak256(RAW));
    const row = store.getTx(r.txId)!;
    expect(row.hash).toBe(keccak256(RAW));
    expect(row.raw).toBe(RAW);
    receipt = true;
    await ex.reconcile();
    expect(store.getTx(r.txId)!.status).toBe("INCLUDED");
    expect(resolved).toEqual(["INCLUDED"]);
  });

  it("a definite node rejection is FAILED (nothing can land)", async () => {
    const store = new Store(":memory:");
    const c = fakeChain({ sendRawTransaction: async () => { throw new Error("nonce too low"); } });
    const ex = new Executor(store, c, ("0x" + "11".repeat(32)) as Hex, "relayer");
    expect((await ex.submit("OPEN_HOUSE", "i1", "openHouse", [])).status).toBe("FAILED");
  });

  it("closes jump the queue ahead of opens (audit M-05)", async () => {
    const store = new Store(":memory:");
    const order: string[] = [];
    const c = fakeChain();
    const ex = new Executor(store, c, ("0x" + "11".repeat(32)) as Hex, "relayer");
    const a = ex.submit("OPEN_HOUSE", "o1", "openHouse", () => { order.push("open1"); return []; });
    const b = ex.submit("OPEN_HOUSE", "o2", "openHouse", () => { order.push("open2"); return []; });
    const d = ex.submit("CLOSE", "c1", "close", () => { order.push("close"); return []; }, { priority: 0 });
    await Promise.all([a, b, d]);
    expect(order).toEqual(["open1", "close", "open2"]); // the close overtakes the queued open
  });

  it("arguments (and so price proofs) are built at send time, and a job past its deadline is never sent", async () => {
    const store = new Store(":memory:");
    const ex = new Executor(store, fakeChain(), ("0x" + "11".repeat(32)) as Hex, "relayer");
    let built = 0;
    const r = await ex.submit("OPEN_HOUSE", "o1", "openHouse", () => { built++; return null; });
    expect(built).toBe(1);
    expect(r.status).toBe("FAILED");
    const late = await ex.submit("OPEN_HOUSE", "o2", "openHouse", () => { built++; return []; }, { deadlineMs: -1 });
    expect(late.status).toBe("FAILED");
    expect(built).toBe(1);
  });
});

describe("audit M-04: a matched pair moves together or not at all", () => {
  it("a cancellation during eligibility leaves neither leg SUBMITTED", async () => {
    const store = new Store(":memory:");
    const now = 1_000_000;
    const row = (id: string, user: string, side: 0 | 1): IntentRow => ({
      id, user, nonce: id, status: "MATCHING", side, collateral: "100000", leverage: 1000, route_mask: 1,
      match_deadline: Math.floor(now / 1000) + 30, expiry: Math.floor(now / 1000) + 60, price_limit: side === 0 ? P("200000").toString() : "1",
      config_version: 1, match_window_ms: 8000, slippage_bps: 2, message: "{}", signature: "0x", route: null, reason: null,
      tx_id: null, position_id: null, timeline: "[]", created_at: now, updated_at: now,
    });
    store.insertIntent(row("L", "alice", 0));
    store.insertIntent(row("S", "bob", 1));
    let executed = 0;
    const m = new Matcher(store, { freshProof: () => ({ price: P("100000").toString(), tsMs: now, payload: "0x01" }) },
      { openMatched: async () => { executed++; return { txId: "t", status: "INCLUDED" }; }, openHouse: async () => ({ txId: "t", status: "INCLUDED" }) },
      { check: async (r) => { if (r.id === "S") store.transition("S", ["MATCHING"], "CANCELLED"); return null; } }, () => {},
      { maxQueuePerBucket: 10, proofMaxAgeMs: 2000, submitMarginMs: 1000, houseAfterDeadlineMs: 1000, positionIdFor: () => "0xpos" }, () => now);
    await m.onNew(store.getIntent("L")!);
    expect(executed).toBe(0);
    expect(store.getIntent("L")!.status).toBe("MATCHING"); // rolled back, free to match again
    expect(store.getIntent("S")!.status).toBe("CANCELLED");
  });
});

describe("audit M-06: rate limits are per user and per real client, not per proxy", () => {
  it("two signed-in users behind the same proxy have separate buckets", async () => {
    const app = Fastify({ trustProxy: "127.0.0.1" });
    await installAuthAndRateLimit(app, { authMode: "privy", max: 2, verify: async (t) => (t.startsWith("u:") ? t : null) });
    app.get("/x", async (req) => ({ ip: req.ip }));
    const hit = (auth: string, xff: string) => app.inject({ method: "GET", url: "/x", remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${auth}`, "x-forwarded-for": xff } });
    expect((await hit("u:alice", "1.1.1.1")).statusCode).toBe(200);
    expect((await hit("u:alice", "1.1.1.1")).statusCode).toBe(200);
    expect((await hit("u:alice", "1.1.1.1")).statusCode).toBe(429); // alice is limited...
    expect((await hit("u:bob", "1.1.1.1")).statusCode).toBe(200); // ...bob is not
  });

  it("unauthenticated clients are limited by their real IP from the trusted proxy", async () => {
    const app = Fastify({ trustProxy: "127.0.0.1" });
    await installAuthAndRateLimit(app, { authMode: "privy", max: 1, verify: async () => null });
    app.get("/x", async (req) => ({ ip: req.ip }));
    const hit = (xff: string) => app.inject({ method: "GET", url: "/x", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": xff } });
    const first = await hit("2.2.2.2");
    expect(first.json().ip).toBe("2.2.2.2");
    expect((await hit("2.2.2.2")).statusCode).toBe(429);
    expect((await hit("3.3.3.3")).statusCode).toBe(200);
  });
});

describe("audit M-08: gas grants have their own ledger", () => {
  it("open mode (no invite row): one grant per wallet, and a daily budget across wallets", () => {
    const store = new Store(":memory:");
    expect(store.reserveGasGrant("0xAbC", 10n)).toBe(true);
    store.updateGasGrant("0xabc", { status: "SENT", tx: "0x1" });
    expect(store.reserveGasGrant("0xabc", 10n)).toBe(false); // once per wallet
    expect(store.gasGrant("0xabc")!.tx).toBe("0x1");
    store.reserveGasGrant("0xdef", 10n);
    expect(store.gasGrantedSince(0)).toBe(20n);
  });
});

describe("audit L-03: indexed history is durable across restarts", () => {
  it("events and the cursor are read back by a new indexer instance", () => {
    const store = new Store(":memory:");
    const mk = () => new EnvioIndexer("t", 143, { DimeProtocol: "0x0000000000000000000000000000000000000001" }, 100n, async () => 200n, async () => 0, store.db);
    mk();
    store.db.prepare("INSERT INTO indexer_events VALUES (?,?,?,?,?,?,?,?,?)").run("0xt1", 0, "150", 150, 1000, "DimeProtocol", "Deposited", "0xa11ce", JSON.stringify({ user: "0xA11CE", amount: "1000000" }));
    store.db.prepare("INSERT INTO indexer_meta VALUES ('next', '151')").run();
    const again = mk();
    expect(again.view().events).toBe(1);
    expect(again.activity("0xA11CE")[0].title).toBe("Deposited $1.00");
  });
});
