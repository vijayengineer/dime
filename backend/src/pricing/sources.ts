import WebSocket from "ws";
import { log } from "../log";
import { Latency } from "../metrics";
import type { Quote, SourceTick } from "./aggregate";
import { parsePrice } from "./decimal";

export interface Parsed {
  bid?: bigint; ask?: bigint; bidSize?: bigint; askSize?: bigint;
  price: bigint; ts: number; seq?: number;
}
export interface Aux { kind: "oracle"; source: string; oraclePx: bigint; markPx?: bigint; ts: number }

export interface SourceDef {
  id: string;
  name: string;
  quote: Quote;
  /** Endpoints tried in rotation; redundant connections start on different entries. */
  urls: string[];
  subscribe?: unknown[];
  parse(msg: any, recvAt: number): Parsed | Aux | null;
  ping?: { payload: unknown; everyMs: number };
  /** Reconnect a connection proactively after this long (staggered across connections). */
  rotateMs?: number;
}

const s = (x: unknown) => parsePrice(String(x));
const bboFrom = (bid: unknown, bidSz: unknown, ask: unknown, askSz: unknown) => {
  const b = s(bid), a = s(ask);
  return { bid: b, ask: a, bidSize: s(bidSz), askSize: s(askSz), price: (b + a) / 2n };
};

/** Public market-data feeds (no keys). Check each venue's terms and limits before production. */
export const SOURCES: Record<string, SourceDef> = {
  hyperliquid: {
    id: "hyperliquid", name: "Hyperliquid BTC perp", quote: "USDC_PERP", urls: ["wss://api.hyperliquid.xyz/ws"],
    subscribe: [
      { method: "subscribe", subscription: { type: "bbo", coin: "BTC" } },
      { method: "subscribe", subscription: { type: "activeAssetCtx", coin: "BTC" } },
    ],
    parse: (m, recvAt) => {
      if (m.channel === "bbo" && m.data?.bbo?.[0] && m.data.bbo[1]) {
        const [b, a] = m.data.bbo;
        return { ...bboFrom(b.px, b.sz, a.px, a.sz), ts: Number(m.data.time), seq: Number(m.data.time) };
      }
      if (m.channel === "activeAssetCtx" && m.data?.ctx?.oraclePx) {
        return { kind: "oracle", source: "hyperliquid-oracle", oraclePx: s(m.data.ctx.oraclePx), markPx: m.data.ctx.markPx ? s(m.data.ctx.markPx) : undefined, ts: recvAt };
      }
      return null;
    },
    ping: { payload: { method: "ping" }, everyMs: 20_000 }, // server closes after 60 s idle
    rotateMs: 6 * 60 * 60 * 1000,
  },
  binance: {
    id: "binance", name: "Binance BTC/USDT spot", quote: "USDT",
    urls: [
      "wss://stream.binance.com:9443/ws/btcusdt@bookTicker",
      "wss://data-stream.binance.vision/ws/btcusdt@bookTicker",
      "wss://stream.binance.com:443/ws/btcusdt@bookTicker",
    ],
    parse: (m, recvAt) => (m.b && m.a ? { ...bboFrom(m.b, m.B, m.a, m.A), ts: recvAt, seq: Number(m.u) } : null),
    rotateMs: 23 * 60 * 60 * 1000, // Binance force-closes connections at 24 h
  },
  coinbase: {
    id: "coinbase", name: "Coinbase BTC-USD", quote: "USD", urls: ["wss://ws-feed.exchange.coinbase.com"],
    subscribe: [{ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] }],
    parse: (m) => (m.type === "ticker" && m.best_bid && m.best_ask
      ? { ...bboFrom(m.best_bid, m.best_bid_size ?? "0", m.best_ask, m.best_ask_size ?? "0"), ts: Date.parse(m.time), seq: m.sequence }
      : null),
  },
  kraken: {
    id: "kraken", name: "Kraken BTC/USD", quote: "USD", urls: ["wss://ws.kraken.com/v2"],
    subscribe: [{ method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USD"], event_trigger: "bbo" } }],
    parse: (m, recvAt) => (m.channel === "ticker" && m.data?.[0]?.bid
      ? { ...bboFrom(m.data[0].bid, m.data[0].bid_qty, m.data[0].ask, m.data[0].ask_qty), ts: recvAt }
      : null),
    ping: { payload: { method: "ping" }, everyMs: 20_000 },
  },
  okx: {
    id: "okx", name: "OKX BTC-USDT spot", quote: "USDT", urls: ["wss://ws.okx.com:8443/ws/v5/public"],
    subscribe: [{ op: "subscribe", args: [{ channel: "bbo-tbt", instId: "BTC-USDT" }] }],
    parse: (m) => (m.arg?.channel === "bbo-tbt" && m.data?.[0]?.bids?.[0] && m.data[0].asks?.[0]
      ? { ...bboFrom(m.data[0].bids[0][0], m.data[0].bids[0][1], m.data[0].asks[0][0], m.data[0].asks[0][1]), ts: Number(m.data[0].ts), seq: Number(m.data[0].seqId) }
      : null),
    ping: { payload: "ping", everyMs: 20_000 },
  },
  bybit: {
    id: "bybit", name: "Bybit BTCUSDT spot", quote: "USDT", urls: ["wss://stream.bybit.com/v5/public/spot"],
    subscribe: [{ op: "subscribe", args: ["orderbook.1.BTCUSDT"] }],
    parse: (m) => (m.topic === "orderbook.1.BTCUSDT" && m.data?.b?.[0] && m.data?.a?.[0]
      ? { ...bboFrom(m.data.b[0][0], m.data.b[0][1], m.data.a[0][0], m.data.a[0][1]), ts: Number(m.ts), seq: Number(m.data.u) }
      : null),
    ping: { payload: { op: "ping" }, everyMs: 20_000 },
  },
};

/* ------------------------------------------------------------------ health */
export interface ConnHealth { id: string; url: string; up: boolean; lastMsgAgeMs: number | null; reconnects: number; connectedForMs: number | null }
export interface SourceHealthView {
  id: string; name: string; quote: Quote; connections: ConnHealth[]; connectionsUp: number;
  available: boolean; uptimePct: number; observedMs: number; gaps: number; maxGapMs: number; lastTickAgeMs: number | null;
  ticks: number; duplicates: number; venueLatency: ReturnType<Latency["summary"]>;
}

/**
 * Availability = a fresh tick within `availableWithinMs`, measured from the first tick.
 * "Gaps" = inter-tick intervals above `gapMs`. For trade-driven feeds (e.g. Coinbase ticker) a gap
 * can simply mean a quiet market, not an outage; connection state is reported separately.
 */
export class SourceHealth {
  readonly conns: { id: string; url: string; up: boolean; lastMsgAt: number | null; reconnects: number; connectedAt: number | null }[] = [];
  lastTickAt: number | null = null;
  ticks = 0;
  duplicates = 0;
  gaps = 0;
  maxGapMs = 0;
  private availableMs = 0;
  private observedMs = 0;
  readonly venueLatency = new Latency(5000);

  constructor(readonly def: SourceDef, private gapMs = 1000, private availableWithinMs = 1000) {}

  onTick(now: number, accepted: boolean) {
    if (!accepted) { this.duplicates++; return; }
    if (this.lastTickAt !== null) {
      const gap = now - this.lastTickAt;
      if (gap > this.gapMs) { this.gaps++; this.maxGapMs = Math.max(this.maxGapMs, gap); }
    }
    this.lastTickAt = now;
    this.ticks++;
  }

  /** Called on a fixed cadence to accumulate availability. */
  sample(now: number, dtMs: number) {
    if (this.lastTickAt === null) return; // availability is measured from the first tick, not process start
    this.observedMs += dtMs;
    if (this.lastTickAt !== null && now - this.lastTickAt <= this.availableWithinMs) this.availableMs += dtMs;
  }

  view(now: number): SourceHealthView {
    const conns = this.conns.map((c) => ({
      id: c.id, url: c.url, up: c.up, reconnects: c.reconnects,
      lastMsgAgeMs: c.lastMsgAt === null ? null : now - c.lastMsgAt,
      connectedForMs: c.up && c.connectedAt !== null ? now - c.connectedAt : null,
    }));
    return {
      id: this.def.id, name: this.def.name, quote: this.def.quote, connections: conns, connectionsUp: conns.filter((c) => c.up).length,
      available: this.lastTickAt !== null && now - this.lastTickAt <= this.availableWithinMs,
      uptimePct: this.observedMs ? Math.round((this.availableMs / this.observedMs) * 100_000) / 1000 : 0,
      observedMs: this.observedMs, gaps: this.gaps, maxGapMs: this.maxGapMs,
      lastTickAgeMs: this.lastTickAt === null ? null : now - this.lastTickAt, ticks: this.ticks, duplicates: this.duplicates,
      venueLatency: this.venueLatency.summary(),
    };
  }
}

/* ------------------------------------------------------------------ connections */
export interface SourceHandle { health: SourceHealth; drop(connIndex: number): void; stop(): void }

/**
 * Runs `redundancy` concurrent connections for one venue. Each connection starts on a different
 * endpoint, reconnects with jittered backoff (rotating endpoints), is killed if silent, and is
 * proactively rotated before forced server disconnects — staggered so they never all cycle at once.
 * Ticks from all connections feed the same aggregator; duplicates are dropped by sequence.
 */
export function connectSource(
  def: SourceDef, redundancy: number,
  onTick: (t: SourceTick) => boolean,
  onAux: (a: Aux) => void,
): SourceHandle {
  const health = new SourceHealth(def);
  const sockets: (WebSocket | null)[] = [];
  let stopped = false;
  let fallbackSeq = 0;

  const run = (i: number, attempt: number, urlIdx: number) => {
    if (stopped) return;
    const url = def.urls[urlIdx % def.urls.length];
    const c = health.conns[i] ?? (health.conns[i] = { id: `${def.id}#${i + 1}`, url, up: false, lastMsgAt: null, reconnects: 0, connectedAt: null });
    c.url = url;
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 8000 });
    sockets[i] = ws;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let silentTimer: ReturnType<typeof setTimeout> | undefined;
    let rotateTimer: ReturnType<typeof setTimeout> | undefined;
    const armSilent = () => { clearTimeout(silentTimer); silentTimer = setTimeout(() => ws.terminate(), 15_000); };

    ws.on("open", () => {
      c.up = true;
      c.connectedAt = Date.now();
      attempt = 0;
      for (const sub of def.subscribe ?? []) ws.send(JSON.stringify(sub));
      if (def.ping) pingTimer = setInterval(() => { if (ws.readyState === ws.OPEN) ws.send(typeof def.ping!.payload === "string" ? def.ping!.payload : JSON.stringify(def.ping!.payload)); }, def.ping.everyMs);
      if (def.rotateMs) {
        // stagger: connection i rotates at (1 + i/redundancy) fraction offsets so they never overlap
        const at = def.rotateMs * (0.5 + (i + 0.5) / (2 * redundancy));
        rotateTimer = setTimeout(() => { log.info({ conn: c.id }, "proactive rotation"); ws.close(); }, at);
      }
      armSilent();
    });
    ws.on("message", (buf) => {
      const recvAt = Date.now();
      c.lastMsgAt = recvAt;
      armSilent();
      let m: any;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      let r: Parsed | Aux | null;
      try { r = def.parse(m, recvAt); } catch (e) { log.warn({ source: def.id, err: (e as Error).message }, "parse error"); return; }
      if (!r) return;
      if ("kind" in r) { onAux(r); return; }
      if (r.price <= 0n) return;
      if (r.ts !== recvAt && Number.isFinite(r.ts)) health.venueLatency.record(recvAt - r.ts);
      const accepted = onTick({
        id: def.id, name: def.name, quote: def.quote, price: r.price, bid: r.bid, ask: r.ask, bidSize: r.bidSize, askSize: r.askSize,
        ts: Number.isFinite(r.ts) ? r.ts : recvAt, recvAt, seq: r.seq ?? ++fallbackSeq,
      });
      health.onTick(recvAt, accepted);
    });
    ws.on("close", () => {
      clearInterval(pingTimer); clearTimeout(silentTimer); clearTimeout(rotateTimer);
      c.up = false;
      c.connectedAt = null;
      if (stopped) return;
      c.reconnects++;
      const delay = Math.min(10_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 200);
      setTimeout(() => run(i, attempt + 1, urlIdx + 1), delay); // rotate endpoint on every reconnect
    });
    ws.on("error", (e) => log.warn({ conn: c.id, url, err: e.message }, "source connection error"));
  };

  for (let i = 0; i < redundancy; i++) setTimeout(() => run(i, 0, i), i * 750);
  return {
    health,
    drop: (i) => sockets[i]?.terminate(),
    stop: () => { stopped = true; sockets.forEach((w) => w?.close()); },
  };
}

/**
 * MOCK sources — local tests only (refused in production by config). Deterministic random walk
 * with sizes, emitted as two "USD" venues, plus shock/set controls.
 */
export function startMockSources(onTick: (t: SourceTick) => boolean, base = 100_000n * 10n ** 8n) {
  let price = base;
  let x = 0x9e3779b9;
  const rand = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 2001) - 1000; };
  let seq = 0;
  const one = 100_000_000n;
  const timer = setInterval(() => {
    price += (price * BigInt(rand())) / 100_000_000n;
    const now = Date.now();
    seq++;
    for (const [id, off] of [["mock-a", 0n], ["mock-b", 1_000_000n]] as const) {
      const p = price + off;
      onTick({ id, name: `MOCK ${id} (test only)`, quote: "USD", price: p, bid: p - 50_000_000n, ask: p + 50_000_000n, bidSize: one, askSize: one, ts: now, recvAt: now, seq });
    }
  }, 100);
  return {
    stop: () => clearInterval(timer),
    shock: (bps: number) => { price += (price * BigInt(bps)) / 10_000n; },
    set: (p: bigint) => { price = p; },
  };
}
