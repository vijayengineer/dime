import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadPricingConfig, readKey } from "../config";
import { log } from "../log";
import { Counters, Latency } from "../metrics";
import { Aggregator, MODEL_VERSION, type Estimate, type SourceTick } from "./aggregate";
import { connectSource, SOURCES, startMockSources, type Aux, type SourceHandle } from "./sources";

/**
 * Pricing service.
 *  - Ingests independent BTC feeds (Hyperliquid + Binance on redundant connections, plus optional
 *    venues), computes a microprice / liquidity-weighted-median ESTIMATE with quality flags and a
 *    plain-median comparison, and tracks per-venue availability (uptime, gaps, reconnects).
 *  - Signs an OPERATOR-CONTROLLED reference proof (testnet / founder-only commissioning). The
 *    signature proves who signed, not that the price is fair.
 *  - Internal WS `/internal` (with proof) for API/keeper; public read-only WS `/feed` (no proof,
 *    throttled) for the frontend. Binds to localhost; expose `/feed` via nginx only if wanted.
 */
const cfg = loadPricingConfig();
const BTC_MARKET = keccak256(toHex("BTC-USD"));
const TAG = keccak256(toHex("DIME_OPERATOR_PRICE_V2"));
/** Price rounds: one signature per 250 ms round, round = floor(tsMs / ROUND_MS) (verifier enforces it). */
const ROUND_MS = 250;
const QUALITY_CODE = { OK: 0, DEGRADED: 1 } as const;
const PROD = cfg.NODE_ENV === "production";
const REDUNDANT = new Set((process.env.REDUNDANT_SOURCES ?? "hyperliquid,binance").split(",").map((x) => x.trim()));
const REDUNDANCY = Number(process.env.REDUNDANCY ?? 2);
const FEED_ORIGINS = (process.env.FEED_ALLOWED_ORIGINS ?? cfg.CORS_ORIGINS).split(",").map((x) => x.trim());

const agg = new Aggregator({ maxAgeMs: cfg.MAX_SOURCE_AGE_MS, maxDisagreementBps: cfg.MAX_DISAGREEMENT_BPS, minSources: cfg.MIN_SOURCES, maxWeightShare: 0.4 });
const internalLatency = new Latency();
const signLatency = new Latency();
const counters = new Counters();
const startedAt = Date.now();
let indexAvailableMs = 0, indexObservedMs = 0, indexGaps = 0, indexMaxGapMs = 0, lastOkAt: number | null = null;

const reporter = cfg.REPORTER_KEY_FILE ? privateKeyToAccount(readKey(cfg.REPORTER_KEY_FILE, "reporter")) : null;
if (!reporter) log.warn("REPORTER_KEY_FILE not set: no reference proofs will be signed");

interface Proof { price: string; tsMs: number; round: number; quality: "OK" | "DEGRADED"; sources: number; obsMs: number; payload: Hex; signer: string }
let latestProof: Proof | null = null;
/** Signed rounds kept for settlement lookups ("first round after this close request"), ~10 minutes. */
const proofsByRound = new Map<number, Proof>();
const PROOF_RING = 2400;
let latestEstimate: Estimate | null = null;
let latestSnapshot: Record<string, unknown> | null = null;
let oracle: { price: string; markPx?: string; ts: number } | null = null;
const internalClients = new Set<WebSocket>();
const feedClients = new Set<WebSocket>();
const handles = new Map<string, SourceHandle>();
const history: { t: number; price: string }[] = []; // 1 s estimate history (OK quality only), last hour

let pending = false;
let pendingRecv: number[] = [];
function onTick(t: SourceTick): boolean {
  const accepted = agg.update(t);
  if (!accepted) { counters.inc("ticks.duplicate"); return false; }
  counters.inc(`ticks.${t.id}`);
  pendingRecv.push(performance.now());
  if (!pending) { pending = true; setImmediate(publish); }
  return true;
}
function onAux(a: Aux) {
  if (a.kind === "oracle") oracle = { price: a.oraclePx.toString(), markPx: a.markPx?.toString(), ts: a.ts };
}

function bpsDiff(a: bigint, b: bigint) { return Number(((a - b) * 1_000_000n) / b) / 100; }

function healthViews(now: number) {
  return [...handles.values()].map((h) => h.health.view(now));
}

function publish() {
  pending = false;
  const now = Date.now();
  const e = agg.compute(now);
  if (!e) return;
  latestEstimate = e;
  if (e.quality === "OK" || e.quality === "DEGRADED") lastOkAt = now;
  const proof = latestProof;
  const health = new Map(healthViews(now).map((h) => [h.id, h]));
  const ticks = new Map(agg.sources().map((s) => [s.id, s]));
  const snap = {
    market: "BTC-USD",
    method: "microprice · liquidity-weighted median (capped 40%/venue) · freshness-decayed",
    estimate: e.estimate.toString(),
    plainMedian: e.plainMedian.toString(),
    divergenceBps: e.divergenceBps,
    reference: proof ? { price: proof.price, ts: proof.tsMs, verifier: "Operator-signed reference (commissioning, not an independent oracle)" } : null,
    crossChecks: oracle ? { hyperliquidOracle: { price: oracle.price, ts: oracle.ts, deviationBps: bpsDiff(BigInt(oracle.price), e.estimate) } } : {},
    sources: e.venues.map((v) => {
      const t = ticks.get(v.id)!;
      const h = health.get(v.id);
      return {
        id: v.id, name: t.name, quote: v.quote, price: v.adjusted.toString(), mid: v.mid.toString(), micro: v.micro.toString(),
        bid: t.bid?.toString(), ask: t.ask?.toString(), ts: t.ts, recvAt: t.recvAt, seq: t.seq,
        used: e.used.includes(v.id), weight: Math.round(v.weight * 10_000) / 10_000, depthUsd: Math.round(v.depthUsd), ageMs: v.ageMs,
        health: h ? {
          connectionsUp: h.connectionsUp, connections: h.connections.length, uptimePct: h.uptimePct, gaps: h.gaps, maxGapMs: h.maxGapMs,
          reconnects: h.connections.reduce((s, c) => s + c.reconnects, 0), duplicates: h.duplicates, latencyP50: h.venueLatency.p50, latencyP99: h.venueLatency.p99,
        } : null,
      };
    }),
    basis: Object.fromEntries(Object.entries(e.basis).map(([k, v]) => [k, v!.toString()])),
    ageMs: e.ageMs,
    disagreementBps: e.disagreementBps,
    referenceDeviationBps: proof ? bpsDiff(e.estimate, BigInt(proof.price)) : null,
    quality: e.quality,
    availability: { uptimePct: indexObservedMs ? Math.round((indexAvailableMs / indexObservedMs) * 100_000) / 1000 : 0, gaps: indexGaps, maxGapMs: indexMaxGapMs, sinceMs: now - startedAt },
    publishedAt: now,
  };
  latestSnapshot = snap;
  if (e.quality === "OK" || e.quality === "DEGRADED") {
    const sec = Math.floor(now / 1000) * 1000;
    if (!history.length || history[history.length - 1].t < sec) { history.push({ t: sec, price: snap.estimate }); if (history.length > 3600) history.shift(); }
  }
  const msg = JSON.stringify({ type: "snapshot", data: snap, proof });
  for (const c of internalClients) if (c.readyState === c.OPEN && c.bufferedAmount < 1 << 20) c.send(msg);
  const done = performance.now();
  for (const r of pendingRecv) internalLatency.record(done - r);
  pendingRecv = [];
  counters.inc("snapshots");
}

// Public feed: throttled to 10/s, no proof payload.
setInterval(() => {
  if (!latestSnapshot || !feedClients.size) return;
  const msg = JSON.stringify({ type: "snapshot", data: latestSnapshot });
  for (const c of feedClients) if (c.readyState === c.OPEN && c.bufferedAmount < 1 << 18) c.send(msg);
}, 100);

// Availability accounting (index-level and per venue), 100 ms cadence.
setInterval(() => {
  const now = Date.now();
  for (const h of handles.values()) h.health.sample(now, 100);
  if (lastOkAt === null) return; // index availability measured from the first good estimate
  indexObservedMs += 100;
  const ok = lastOkAt !== null && now - lastOkAt <= 1000;
  if (ok) {
    indexAvailableMs += 100;
    if (outageStart !== null) { indexMaxGapMs = Math.max(indexMaxGapMs, now - outageStart); outageStart = null; }
  } else if (lastOkAt !== null && outageStart === null) {
    outageStart = lastOkAt; // one outage counted once, measured from the last good estimate
    indexGaps++;
  }
}, 100);
let outageStart: number | null = null;

let lastSignedRound = -1;
async function signReference() {
  if (!reporter) return;
  const tsMs = Date.now();
  const round = Math.floor(tsMs / ROUND_MS);
  if (round <= lastSignedRound) return; // exactly one signature per round
  const e = agg.compute(tsMs);
  if (!e || (e.quality !== "OK" && e.quality !== "DEGRADED")) { counters.inc("proof.skippedQuality"); return; }
  lastSignedRound = round;
  const t0 = performance.now();
  const quality = QUALITY_CODE[e.quality];
  const sources = e.used.length;
  const obsMs = Math.min(e.obsMs || tsMs, tsMs);
  const inner = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" },
      { type: "uint64" }, { type: "uint8" }, { type: "uint8" }, { type: "uint64" }],
    [TAG, BigInt(cfg.CHAIN_ID), cfg.manifest!.verifier, BTC_MARKET, e.estimate, BigInt(tsMs), BigInt(round), quality, sources, BigInt(obsMs)],
  ));
  const sig = await reporter.signMessage({ message: { raw: inner } });
  const payload = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "uint8" }, { type: "uint64" }, { type: "bytes" }],
    [e.estimate, BigInt(tsMs), BigInt(round), quality, sources, BigInt(obsMs), sig],
  );
  const proof: Proof = { price: e.estimate.toString(), tsMs, round, quality: e.quality, sources, obsMs, payload, signer: reporter.address };
  latestProof = proof;
  proofsByRound.set(round, proof);
  if (proofsByRound.size > PROOF_RING) proofsByRound.delete(proofsByRound.keys().next().value!);
  const msg = JSON.stringify({ type: "proof", proof });
  for (const c of internalClients) if (c.readyState === c.OPEN && c.bufferedAmount < 1 << 20) c.send(msg);
  // Everything needed to replay this round: model version, every input with exchange and receipt times,
  // full-precision weights, the basis state it used and when that basis last changed (audit L-02).
  const bs = agg.basisState();
  audit({
    model: MODEL_VERSION, round, tsMs, price: e.estimate.toString(), quality: e.quality, sources, obsMs, signer: reporter.address, sig,
    plainMedian: e.plainMedian.toString(), disagreementBps: e.disagreementBps, rawDisagreementBps: e.rawDisagreementBps, anchorSources: e.anchorSources,
    used: e.used,
    params: { maxAgeMs: cfg.MAX_SOURCE_AGE_MS, maxDisagreementBps: cfg.MAX_DISAGREEMENT_BPS, minSources: cfg.MIN_SOURCES, maxWeightShare: 0.4 },
    basis: Object.fromEntries(Object.entries(bs.basis).map(([k, v]) => [k, v!.toString()])),
    basisUpdatedAt: bs.updatedAt,
    inputs: agg.sources().map((t) => ({
      id: t.id, quote: t.quote, bid: t.bid?.toString(), ask: t.ask?.toString(), bidSize: t.bidSize?.toString(), askSize: t.askSize?.toString(),
      price: t.price.toString(), ts: t.ts, recvAt: t.recvAt, hasSourceTs: t.hasSourceTs ?? t.ts !== t.recvAt, seq: t.seq,
    })),
    venues: e.venues.map((v) => ({ id: v.id, micro: v.micro.toString(), adjusted: v.adjusted.toString(), depthUsd: v.depthUsd, freshness: v.freshness, weight: v.weight, obsMs: v.obsMs })),
  });
  signLatency.record(performance.now() - t0);
  counters.inc("proof.signed");
}

/* ------------------------------------------------------------------ audit log */
// Every signed reference price with the exact venue inputs that produced it, so anyone can
// recompute it from public exchange data. Daily JSONL files, kept AUDIT_RETAIN_DAYS (default 7).
const AUDIT_DIR = path.resolve(process.env.AUDIT_DIR ?? "./data/audit");
const AUDIT_RETAIN_DAYS = Number(process.env.AUDIT_RETAIN_DAYS ?? 7);
fs.mkdirSync(AUDIT_DIR, { recursive: true });
const auditRecent: unknown[] = [];
let lastAuditError: { at: number; message: string } | null = null;
const dayFile = (ms: number) => path.join(AUDIT_DIR, `${new Date(ms).toISOString().slice(0, 10)}.jsonl`);
function audit(rec: { tsMs: number } & Record<string, unknown>) {
  auditRecent.push(rec);
  if (auditRecent.length > 500) auditRecent.shift();
  fs.appendFile(dayFile(rec.tsMs), JSON.stringify(rec) + "\n", (err) => {
    if (err) { counters.inc("audit.writeError"); lastAuditError = { at: Date.now(), message: err.message }; log.error({ err: err.message }, "audit write failed"); }
  });
}
function pruneAudit() {
  const cutoff = Date.now() - AUDIT_RETAIN_DAYS * 86_400_000;
  for (const f of fs.readdirSync(AUDIT_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && Date.parse(m[1]) < cutoff) fs.rmSync(path.join(AUDIT_DIR, f), { force: true });
  }
}
pruneAudit();
setInterval(pruneAudit, 3_600_000);

/* ------------------------------------------------------------------ sources */
const ids = cfg.PRICE_SOURCES.split(",").map((x) => x.trim()).filter(Boolean);
let mock: ReturnType<typeof startMockSources> | null = null;
if (ids.includes("mock")) {
  log.warn("MOCK price sources active — local testing only");
  mock = startMockSources(onTick);
} else {
  for (const id of ids) {
    const def = SOURCES[id];
    if (!def) throw new Error(`unknown price source ${id}`);
    const n = REDUNDANT.has(id) ? REDUNDANCY : 1;
    handles.set(id, connectSource(def, n, onTick, onAux));
    log.info({ source: id, connections: n }, "source started");
  }
}
// Sign right after each 250 ms round boundary (aligned, so every round gets its signature when healthy).
function scheduleSign() {
  const now = Date.now();
  const next = (Math.floor(now / ROUND_MS) + 1) * ROUND_MS + 5;
  setTimeout(() => { void signReference().catch((e) => log.error({ err: e.message }, "sign failed")); scheduleSign(); }, next - now);
}
scheduleSign();
setInterval(publish, 500); // heartbeat so consumers see staleness even when feeds go quiet

/* ------------------------------------------------------------------ server */
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const origin = req.headers.origin;
  const cors: Record<string, string> = origin && FEED_ORIGINS.includes(origin) ? { "access-control-allow-origin": origin, vary: "origin" } : {};
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", ...cors }); res.end(JSON.stringify(body)); };
  const now = Date.now();
  if (url.pathname === "/health" || url.pathname === "/feed/health") {
    // Healthy = an OK multi-venue quorum. DEGRADED rounds are still signed for settlement but never open trades.
    const ok = latestSnapshot?.quality === "OK" && !(lastAuditError && now - lastAuditError.at < 60_000);
    return json(ok ? 200 : 503, {
      ok, quality: latestSnapshot?.quality ?? "NONE", proofAgeMs: latestProof ? now - latestProof.tsMs : null,
      proofQuality: latestProof?.quality ?? null, model: MODEL_VERSION, lastAuditError, rejectedTicks: agg.rejected,
      sources: healthViews(now), index: (latestSnapshot as { availability?: unknown } | null)?.availability ?? null,
    });
  }
  if (url.pathname === "/metrics" || url.pathname === "/feed/metrics") {
    return json(200, {
      measuredAt: new Date().toISOString(), uptimeMs: now - startedAt,
      internalRecvToPublishMs: internalLatency.summary(), proofSignMs: signLatency.summary(),
      sources: healthViews(now).map((h) => ({ id: h.id, uptimePct: h.uptimePct, gaps: h.gaps, maxGapMs: h.maxGapMs, connectionsUp: h.connectionsUp, ticks: h.ticks, duplicates: h.duplicates, venueTsToRecvMs: h.venueLatency })),
      estimate: latestEstimate ? { quality: latestEstimate.quality, divergenceVsPlainMedianBps: latestEstimate.divergenceBps, disagreementBps: latestEstimate.disagreementBps } : null,
      counters: counters.toJSON(),
      note: "venueTsToRecv includes exchange clock skew and network; internal is process time only",
    });
  }
  if (url.pathname === "/feed/audit") {
    // Latest signed prices with their inputs (newest last). Full days: /feed/audit/YYYY-MM-DD
    const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 50));
    return json(200, { note: "Operator-signed reference prices with venue inputs. Auditable, not an independent oracle.", signer: reporter?.address ?? null, records: auditRecent.slice(-limit) });
  }
  const day = url.pathname.match(/^\/feed\/audit\/(\d{4}-\d{2}-\d{2})$/);
  if (day) {
    const f = path.join(AUDIT_DIR, `${day[1]}.jsonl`);
    if (!fs.existsSync(f)) return json(404, { error: "no audit file for that day" });
    res.writeHead(200, { "content-type": "application/x-ndjson", ...cors });
    return void fs.createReadStream(f).pipe(res);
  }
  if (url.pathname === "/feed/history") {
    const limit = Math.min(3600, Number(url.searchParams.get("limit") ?? 600));
    return json(200, { points: history.slice(-limit) });
  }
  if (url.pathname === "/snapshot") return json(latestSnapshot ? 200 : 503, latestSnapshot ?? { error: "no snapshot" });
  if (url.pathname === "/proof/latest") return json(latestProof ? 200 : 503, latestProof ?? { error: "no proof" });
  if (url.pathname === "/proof/after") {
    // The first signed round strictly after `round` (settlement of a close request), if we have it yet.
    const after = Number(url.searchParams.get("round"));
    for (let r = after + 1; r <= after + 40; r++) { const p = proofsByRound.get(r); if (p) return json(200, p); }
    return json(404, { error: "no signed round after that yet" });
  }
  if (!PROD && req.method === "POST" && url.pathname === "/debug/drop") {
    // Failover drill (non-production): kill one connection and watch the other keep the feed alive.
    const h = handles.get(url.searchParams.get("source") ?? "");
    if (!h) return json(404, { error: "unknown source" });
    h.drop(Number(url.searchParams.get("conn") ?? 0));
    return json(200, { ok: true });
  }
  if (mock && req.method === "POST" && url.pathname === "/mock/shock") { mock.shock(Number(url.searchParams.get("bps") ?? 0)); return json(200, { ok: true }); }
  if (mock && req.method === "POST" && url.pathname === "/mock/set") { mock.set(BigInt(url.searchParams.get("price") ?? "0")); return json(200, { ok: true }); }
  json(404, { error: "not found" });
});
const internalWss = new WebSocketServer({ noServer: true });
const feedWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/internal") {
    if (req.headers.origin) { socket.destroy(); return; } // browsers never get the proof stream
    internalWss.handleUpgrade(req, socket, head, (ws) => {
      internalClients.add(ws);
      if (latestSnapshot) ws.send(JSON.stringify({ type: "snapshot", data: latestSnapshot, proof: latestProof }));
      ws.on("close", () => internalClients.delete(ws));
    });
  } else if (path === "/feed") {
    if (req.headers.origin && !FEED_ORIGINS.includes(req.headers.origin)) { socket.destroy(); return; }
    if (feedClients.size >= 500) { socket.destroy(); return; }
    feedWss.handleUpgrade(req, socket, head, (ws) => {
      feedClients.add(ws);
      if (latestSnapshot) ws.send(JSON.stringify({ type: "snapshot", data: latestSnapshot }));
      ws.on("close", () => feedClients.delete(ws));
    });
  } else socket.destroy();
});
server.listen(cfg.PRICING_PORT, process.env.PRICING_HOST ?? "127.0.0.1", () => log.info({ port: cfg.PRICING_PORT, sources: ids }, "pricing service up"));

process.on("SIGTERM", () => { mock?.stop(); for (const h of handles.values()) h.stop(); server.close(); process.exit(0); });
