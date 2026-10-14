import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { verifyMessage, type Address, type Hex } from "viem";
import { z } from "zod";
import { loadConfig, readKey } from "../config";
import { log } from "../log";
import { Counters, Latency } from "../metrics";
import { Store, type IntentRow, TERMINAL } from "../store/db";
import { PriceClient, roundOf } from "../pricing/client";
import { BTC_MARKET, makeChain, parseOrder, positionIdFor, PROTOCOL_STATES, revertName, toWire, verifyClose, verifyOrder } from "../chain/chain";
import { Executor } from "../chain/executor";
import { EventWatcher, type SettlementWire } from "../chain/events";
import { Matcher } from "../matching/matcher";
import { EnvioIndexer } from "../indexer/envio";
import { GasFaucet } from "../faucet/faucet";
import { installAuthAndRateLimit, type AuthedRequest } from "./limits";
import { autoExecution, maxLeverageFor } from "../../../shared/execution";
import { TERMS_VERSION, termsMessage } from "../../../shared/terms";

/* ================================================================ wiring */
const cfg = loadConfig();
const store = new Store(cfg.DB_PATH);
const c = makeChain(cfg);
const prices = new PriceClient(cfg.PRICING_URL);
const relayer = new Executor(store, c, readKey(cfg.RELAYER_KEY_FILE, "relayer"), "relayer");
const metrics = { quote: new Latency(), admit: new Latency(), close: new Latency(), counters: new Counters() };

/* ---------------------------------------------------------------- chain state cache */
interface ChainState {
  config: Awaited<ReturnType<typeof readConfig>>;
  house: Awaited<ReturnType<typeof readHouse>>;
  state: (typeof PROTOCOL_STATES)[number];
  allowlist: boolean;
  at: number;
}
const readConfig = () => c.pub.readContract({ ...c.protocol, functionName: "activeConfig" });
const readHouse = () => c.pub.readContract({ ...c.protocol, functionName: "houseStats" });
let chainState: ChainState | null = null;
async function refreshChainState() {
  try {
    const [config, house, st, allowlist] = await Promise.all([
      readConfig(), readHouse(),
      c.pub.readContract({ ...c.protocol, functionName: "protocolState" }),
      c.pub.readContract({ ...c.protocol, functionName: "allowlistEnabled" }),
    ]);
    chainState = { config, house, state: PROTOCOL_STATES[st], allowlist, at: Date.now() };
  } catch (e) { log.warn({ err: (e as Error).message }, "chain state refresh failed"); }
}
setInterval(refreshChainState, 1000);
await refreshChainState();

/* ---------------------------------------------------------------- stream hub */
const channels = new Map<string, Set<WebSocket>>();
function publish(channel: string, data: unknown) {
  const subs = channels.get(channel);
  if (!subs?.size) return;
  const msg = toWire({ channel, data });
  for (const ws of subs) if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1 << 20) ws.send(msg);
}

function intentWire(r: IntentRow) {
  return {
    id: r.id,
    draft: {
      side: r.side === 0 ? "LONG" : "SHORT", collateral: r.collateral, leverage: r.leverage,
      routes: { matched: !!(r.route_mask & 1), houseFallback: !!(r.route_mask & 2) },
      matchWindowMs: r.match_window_ms, slippageBps: r.slippage_bps,
    },
    status: r.status, route: r.route ?? undefined, reason: r.reason ?? undefined,
    matchDeadline: r.match_deadline * 1000, expiresAt: r.expiry * 1000,
    txHash: r.tx_id ?? undefined, positionId: r.position_id ?? undefined, updatedAt: r.updated_at,
    timeline: JSON.parse(r.timeline),
  };
}
const notify = (r: IntentRow) => publish(`intents:${r.user}`, intentWire(r));

/* ---------------------------------------------------------------- matcher */
const matcher = new Matcher(
  store, prices,
  {
    // The opening proof is fetched when the transaction is actually sent (audit M-05).
    openMatched: (L, S) => relayer.submit("OPEN_MATCHED", `${L.id},${S.id}`, "openMatched", () => {
      const p = prices.freshProof(2000, "open");
      return p ? [parseOrder(JSON.parse(L.message)), L.signature, parseOrder(JSON.parse(S.message)), S.signature, { payload: p.payload }] : null;
    }, { priority: 1, deadlineMs: 4000 }),
    openHouse: (r) => relayer.submit("OPEN_HOUSE", r.id, "openHouse", () => {
      const p = prices.freshProof(2000, "open");
      return p ? [parseOrder(JSON.parse(r.message)), r.signature, { payload: p.payload }] : null;
    }, { priority: 1, deadlineMs: 4000 }),
  },
  {
    async check(r) {
      const user = r.user as Address;
      const [free, pos, used] = await Promise.all([
        c.pub.readContract({ ...c.protocol, functionName: "freeBalance", args: [user] }),
        c.pub.readContract({ ...c.protocol, functionName: "positionOf", args: [user] }),
        c.pub.readContract({ ...c.protocol, functionName: "nonceUsed", args: [user, BigInt(r.nonce)] }),
      ]);
      if (used) return "Request was cancelled on-chain or already used. Nothing was opened.";
      if (pos.user !== "0x0000000000000000000000000000000000000000") return "You already have an open position.";
      if (free < BigInt(r.collateral)) return "Not enough free balance. Nothing was opened.";
      return null;
    },
  },
  notify,
  {
    maxQueuePerBucket: cfg.MAX_QUEUE_PER_BUCKET,
    proofMaxAgeMs: 2000,
    submitMarginMs: 1200,
    houseAfterDeadlineMs: 1500,
    positionIdFor: (r) => positionIdFor(cfg.CHAIN_ID, cfg.manifest.protocol, r.user as Address, BigInt(r.nonce)),
  },
);
setInterval(() => void matcher.tick().catch((e) => log.error({ err: e.message }, "matcher tick failed")), 200);

/* ---------------------------------------------------------------- request recovery (audit M-03 / M-04) */
const ZERO = "0x0000000000000000000000000000000000000000";
const PENDING_TX = new Set(["PREPARED", "SIGNED", "SENT", "UNKNOWN"]);
/**
 * Decide a SUBMITTED request from authoritative chain state: its position exists → OPENED; its nonce is
 * unused and no transaction for it can still land → REJECTED. Waits while a journalled tx is pending.
 */
async function resolveSubmitted(r: IntentRow, minAgeMs: number) {
  if (r.status !== "SUBMITTED" || Date.now() - r.updated_at < minAgeMs) return;
  const pid = positionIdFor(cfg.CHAIN_ID, cfg.manifest.protocol, r.user as Address, BigInt(r.nonce)).toLowerCase() as Hex;
  const done = (to: IntentRow["status"], patch: Partial<IntentRow>, note: string) => {
    if (store.transition(r.id, ["SUBMITTED"], to, patch, note)) notify(store.getIntent(r.id)!);
  };
  try {
    const [pos, used] = await Promise.all([
      c.pub.readContract({ ...c.protocol, functionName: "getPosition", args: [pid] }),
      c.pub.readContract({ ...c.protocol, functionName: "nonceUsed", args: [r.user as Address, BigInt(r.nonce)] }),
    ]);
    if (pos.user !== ZERO || store.getPosition(pid)) return done("OPENED", { position_id: pid }, "Confirmed from chain state");
    const txs = store.txsForRef(r.id);
    const pending = txs.some((t) => PENDING_TX.has(t.status));
    if (pending && Date.now() - r.updated_at < 10 * 60_000) return; // still reconciling the broadcast
    if (used) {
      // Nonce consumed without a known position: it may have opened and closed already; give the indexer time.
      if (Date.now() - r.updated_at > 2 * 60_000) done("CANCELLED", { reason: "Request was used or cancelled on-chain." }, "Resolved from chain state");
      return;
    }
    done("REJECTED", { reason: "The transaction did not land. Nothing was opened." }, "Resolved from chain state");
  } catch (e) {
    log.warn({ id: r.id, err: (e as Error).message.slice(0, 120) }, "could not resolve submitted request yet");
  }
}
async function sweepSubmitted(minAgeMs = 15_000) {
  for (const r of store.intentsByStatus("SUBMITTED")) await resolveSubmitted(r, minAgeMs);
}
relayer.onResolved((t) => {
  if (t.kind !== "OPEN_HOUSE" && t.kind !== "OPEN_MATCHED") return;
  for (const id of t.ref.split(",")) { const r = store.getIntent(id); if (r) void resolveSubmitted(r, 0); }
});
setInterval(() => void sweepSubmitted().catch(() => {}), 5_000);

/** Plain-language close failures (the contract error names are kept in `revert`). */
function closeFailure(revert: string | null | undefined, error?: string) {
  if (revert === "StateForbids") return "Closing is paused while the price is on hold. Your position is unchanged.";
  if (revert === "BadRound" || error?.includes("no eligible price")) return "The price for your close wasn't ready in time. Your position is unchanged. Please try again.";
  if (revert === "Expired" || revert === "BadRequestTime") return "That close request expired. Your position is unchanged. Please try again.";
  if (revert === "UnknownPosition") return "That position is already closed.";
  if (revert === "NonceUsed") return "That close request was already used.";
  if (error?.includes("queue")) return "The network is busy. Your position is unchanged. Please try again.";
  return "Your close didn't go through. Your position is unchanged. Please try again.";
}

/* ---------------------------------------------------------------- events */
const watcher = new EventWatcher(c, store, cfg.manifest.deploymentBlock);
watcher.on("opened", (o: { id: string; user: string; txHash: string; block: bigint }) => {
  const r = store.intentByPosition(o.id) ?? store.latestIntentForUser(o.user);
  if (r && r.status === "SUBMITTED" && positionIdFor(cfg.CHAIN_ID, cfg.manifest.protocol, r.user as Address, BigInt(r.nonce)).toLowerCase() === o.id) {
    if (store.transition(r.id, ["SUBMITTED"], "OPENED", { tx_id: o.txHash, position_id: o.id }, "Confirmed by event")) notify(store.getIntent(r.id)!);
  }
});
watcher.on("settled", (s: SettlementWire) => publish(`settlements:${s.user}`, s));
watcher.start();
setInterval(() => void relayer.reconcile(), 5_000);

prices.on("snapshot", (s) => publish("price:BTC-USD", s));

/* ---------------------------------------------------------------- invite-only live test + gas top-ups */
const inviteOnly = !!cfg.INVITE_CODE;
const faucet = cfg.FAUCET_KEY_FILE
  ? new GasFaucet(c, readKey(cfg.FAUCET_KEY_FILE, "faucet"), store, cfg.FAUCET_DRIP_WEI, cfg.FAUCET_MIN_BALANCE_WEI, cfg.FAUCET_DAILY_BUDGET_WEI)
  : null;
if (faucet) setInterval(() => void faucet.reconcile().catch(() => {}), 30_000);
if (inviteOnly) log.info({ max: cfg.MAX_INVITED, joined: store.invitedCount() }, "invite-only live test");
if (faucet) log.info({ faucet: faucet.address }, "gas faucet enabled");
const canTrade = (address: string) => store.hasAcceptedTerms(address, TERMS_VERSION) && (!inviteOnly || store.isInvited(address));

/* ---------------------------------------------------------------- envio (HyperRPC) */
const envio = cfg.ENVIO_API_TOKEN
  ? new EnvioIndexer(cfg.ENVIO_API_TOKEN, cfg.CHAIN_ID, {
      DimeProtocol: cfg.manifest.protocol, PriceVerifier: cfg.manifest.verifier,
      ...(cfg.manifest.dimeToken ? { DimeToken: cfg.manifest.dimeToken as Address } : {}),
    }, BigInt(cfg.manifest.deploymentBlock), () => c.pub.getBlockNumber(),
    async (n) => Number((await c.pub.getBlock({ blockNumber: n })).timestamp) * 1000, store.db)
  : null;
envio?.start();
if (!envio) log.warn("ENVIO_API_TOKEN not set: /v1/indexer disabled");

/* ================================================================ http */
// Trust X-Forwarded-For only from the local reverse proxy (Caddy), so req.ip is the real client (audit M-06).
const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: cfg.TRUST_PROXY });
await app.register(cors, { origin: cfg.CORS_ORIGINS.split(",").map((s) => s.trim()), methods: ["GET", "POST"] });

const jwks = cfg.PRIVY_APP_ID ? createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${cfg.PRIVY_APP_ID}/jwks.json`)) : null;
await installAuthAndRateLimit(app, {
  authMode: cfg.AUTH_MODE, max: cfg.RATE_LIMIT_PER_MIN,
  verify: async (token) => {
    if (!jwks) return null;
    const { payload } = await jwtVerify(token, jwks, { issuer: "privy.io", audience: cfg.PRIVY_APP_ID });
    return String(payload.sub);
  },
});
await app.register(websocket, { options: { maxPayload: 4096 } });

async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  if (cfg.AUTH_MODE === "none") return;
  const r = req as AuthedRequest;
  if (!r.userId) return reply.code(401).send(err("UNAUTHENTICATED", r.authError ?? "Sign in required"));
}
const err = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { code, message, ...extra } });
const json = (reply: FastifyReply, code: number, body: unknown) => reply.code(code).header("content-type", "application/json").send(toWire(body));

app.get("/health", async (_q, reply) => {
  const proof = prices.freshProof(3000);
  const ok = !!chainState && Date.now() - chainState.at < 5000 && !!proof;
  return json(reply, ok ? 200 : 503, {
    ok, price: prices.snapshot?.quality ?? "NONE", proofAgeMs: prices.proof ? Date.now() - prices.proof.tsMs : null,
    opensAvailable: !!prices.freshProof(2000, "open"), // settlement continues on DEGRADED; opening needs OK
    chainStateAgeMs: chainState ? Date.now() - chainState.at : null, indexedBlock: watcher.lastBlock, headBlock: watcher.headBlock,
    relayerQueue: relayer.queueDepth, relayerOldestQueuedMs: relayer.oldestQueuedMs, protocolState: chainState?.state,
  });
});

// Deployment evidence (fixed at deploy) is kept separate from the live, block-stamped configuration (audit L-01).
app.get("/v1/manifest", async (_q, reply) => json(reply, 200, {
  ...cfg.manifest,
  deployment: cfg.manifest,
  current: chainState ? {
    readAt: new Date(chainState.at).toISOString(), protocolState: chainState.state, contractAllowlist: chainState.allowlist,
    applicationInviteOnly: inviteOnly, config: chainState.config, house: chainState.house,
  } : null,
}));

app.get("/v1/markets/BTC-USD/history", async (req, reply) => {
  const limit = Math.min(3600, Number((req.query as { limit?: string }).limit ?? 600));
  return json(reply, 200, { points: prices.history.slice(-limit) });
});

/* ---------------------------------------------------------------- quotes */
const DraftSchema = z.object({
  market: z.literal("BTC-USD").optional(),
  side: z.enum(["LONG", "SHORT"]),
  collateral: z.string().regex(/^\d+$/),
  leverage: z.number().int().min(1).max(1000),
  // Optional: the server auto-selects these (shared/execution.ts); client values are ignored.
  routes: z.object({ matched: z.boolean(), houseFallback: z.boolean() }).optional(),
  matchWindowMs: z.number().int().min(0).max(60_000).optional(),
  slippageBps: z.number().int().min(0).max(500).optional(),
});
const quotes = new Map<string, { at: number }>();

app.post("/v1/quotes", { preHandler: authenticate, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
  const t0 = performance.now();
  const d = DraftSchema.safeParse(req.body);
  if (!d.success) return json(reply, 400, err("BAD_REQUEST", d.error.issues[0].message));
  const proof = prices.freshProof(2500, "open");
  if (!proof || !chainState) return json(reply, 503, err("PRICE_UNAVAILABLE", "No fresh multi-venue price, so new positions are paused. Closing still works."));
  const { config: k, house: h } = chainState;
  const px = BigInt(proof.price);
  const coll = BigInt(d.data.collateral);
  if (coll < k.minCollateral || coll > k.maxCollateral) return json(reply, 400, err("BAD_SIZE", "Margin outside allowed range"));
  if (d.data.leverage > k.maxLeverage) return json(reply, 400, err("BAD_SIZE", "Leverage above maximum"));
  if (d.data.leverage > maxLeverageFor(coll, k.maxLeverage)) return json(reply, 400, err("BAD_SIZE", `Max ${maxLeverageFor(coll, k.maxLeverage)}× at this margin ($100 exposure cap)`));
  const isLong = d.data.side === "LONG";
  const houseCheckReason = (() => {
    const res = coll * BigInt(k.houseReservationMultiple);
    const nn = h.netDirectionalNotional + (isLong ? coll * BigInt(d.data.leverage) : -(coll * BigInt(d.data.leverage)));
    const ab = (x: bigint) => (x < 0n ? -x : x);
    if (chainState.state !== "OPEN") return `Protocol is ${chainState.state}`;
    if (h.openHousePositions >= k.maxConcurrentHousePositions) return "House position slots are full";
    if (res > h.availableCapacity) return "Not enough house reserve capacity";
    if (ab(nn) > h.reserve * BigInt(k.houseMaxNetNotionalMultiple) && ab(nn) > ab(h.netDirectionalNotional)) return "House is at its concentration limit";
    return undefined;
  })();
  const auto = autoExecution({ leverage: d.data.leverage, maintenanceBps: k.maintenanceBps, houseAvailable: !houseCheckReason });
  const slip = (px * BigInt(auto.slippageBps)) / 10_000n;
  const move = (px * (10_000n - BigInt(k.maintenanceBps))) / (10_000n * BigInt(d.data.leverage));
  const notional = coll * BigInt(d.data.leverage);
  const reservation = coll * BigInt(k.houseReservationMultiple);
  const houseReason = houseCheckReason;
  const gross = (notional * 5n) / 10_000n; // 0.05% example move
  const fee = (gross * BigInt(k.profitFeeBps) + 9_999n) / 10_000n;
  const id = randomUUID();
  quotes.set(id, { at: Date.now() });
  if (quotes.size > 10_000) quotes.delete(quotes.keys().next().value!);
  const latency = performance.now() - t0;
  metrics.quote.record(latency);
  return json(reply, 200, {
    id, indicativeEntry: px, priceLimit: isLong ? px + slip : px - slip, liquidationPrice: isLong ? px - move : px + move,
    feeBps: k.profitFeeBps, exampleMovePct: 0.05, exampleNetProfit: gross - fee, exampleFee: fee,
    capacity: {
      houseAvailable: !houseReason, houseReason, houseReservationRequired: reservation, houseCapacityRemaining: h.availableCapacity,
      housePositionsRemaining: k.maxConcurrentHousePositions - h.openHousePositions,
      matchedPairsRemaining: k.maxConcurrentMatchedPairs - h.openMatchedPairs,
      matchedOppositeWaiting: matcher.waiting(d.data.collateral, d.data.leverage, isLong ? 1 : 0),
    },
    configVersion: k.version, expiresAt: Date.now() + 10_000, serverLatencyMs: Math.round(latency * 1000) / 1000,
    auto,
  });
});

/* ---------------------------------------------------------------- intents */
const IntentBody = z.object({
  quoteId: z.string().optional(),
  message: z.record(z.string(), z.unknown()),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  matchWindowMs: z.number().int().optional(),
  slippageBps: z.number().int().optional(),
});

app.post("/v1/intents", { preHandler: authenticate, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
  const t0 = performance.now();
  const key = String(req.headers["idempotency-key"] ?? "");
  if (!key) return json(reply, 400, err("BAD_REQUEST", "Idempotency-Key header required"));
  const prior = store.idem(`intent:${key}`);
  if (prior) return reply.code(200).header("content-type", "application/json").send(prior);
  const b = IntentBody.safeParse(req.body);
  if (!b.success) return json(reply, 400, err("BAD_REQUEST", b.error.issues[0].message));
  let m;
  try { m = parseOrder(b.data.message); } catch { return json(reply, 400, err("BAD_REQUEST", "Malformed intent")); }
  const sig = b.data.signature as Hex;
  if (m.market.toLowerCase() !== BTC_MARKET.toLowerCase()) return json(reply, 400, err("BAD_MARKET", "BTC-USD only"));
  if (!(await verifyOrder(c, m, sig))) return json(reply, 401, err("BAD_SIGNATURE", "Signature does not match the request"));
  if (!store.hasAcceptedTerms(m.user, TERMS_VERSION)) return json(reply, 403, err("TERMS_REQUIRED", "Accept the Terms of Use before trading"));
  if (!canTrade(m.user)) return json(reply, 403, err("INVITE_REQUIRED", "Live trading is invite-only right now. Join with an invite code first."));
  if (!chainState) return json(reply, 503, err("UNAVAILABLE", "Chain state unavailable"));
  if (chainState.state !== "OPEN") return json(reply, 409, err("STATE", `Protocol is ${chainState.state}`));
  if (m.configVersion !== chainState.config.version) return json(reply, 409, err("CONFIG_CHANGED", "Configuration changed — review again"));
  const nowS = Math.floor(Date.now() / 1000);
  if (Number(m.expiry) <= nowS) return json(reply, 409, err("EXPIRED", "Request already expired"));
  if (m.routeMask === 0 || m.routeMask > 3) return json(reply, 400, err("BAD_ROUTE", "Choose at least one route"));
  if (m.leverage > maxLeverageFor(m.collateral, chainState.config.maxLeverage)) return json(reply, 400, err("BAD_SIZE", "Above the $100 exposure cap: lower the leverage"));
  if (store.liveIntentForUser(m.user)) return json(reply, 409, err("PENDING", "A request is already pending"));
  if (store.intentByNonce(m.user, m.nonce.toString())) return json(reply, 409, err("NONCE_USED", "Nonce already used"));
  const user = m.user.toLowerCase();
  const row: IntentRow = {
    id: randomUUID(), user, nonce: m.nonce.toString(), status: m.routeMask & 1 ? "MATCHING" : "SUBMITTED",
    side: m.side as 0 | 1, collateral: m.collateral.toString(), leverage: m.leverage, route_mask: m.routeMask,
    match_deadline: Number(m.matchDeadline), expiry: Number(m.expiry), price_limit: m.priceLimit.toString(),
    config_version: m.configVersion, match_window_ms: b.data.matchWindowMs ?? Math.max(0, (Number(m.matchDeadline) - nowS) * 1000),
    slippage_bps: b.data.slippageBps ?? 0, message: toWire(m), signature: sig, route: m.routeMask & 1 ? null : "HOUSE",
    reason: null, tx_id: null, position_id: null,
    timeline: JSON.stringify([{ status: m.routeMask & 1 ? "MATCHING" : "SUBMITTED", at: Date.now() }]),
    created_at: Date.now(), updated_at: Date.now(),
  };
  if (row.status === "MATCHING" && !matcher.canAdmit(row)) return json(reply, 429, err("QUEUE_FULL", "Too many waiting requests at this size; try again"));
  store.insertIntent(row);
  const body = toWire(intentWire(row));
  store.saveIdem(`intent:${key}`, body);
  metrics.admit.record(performance.now() - t0);
  metrics.counters.inc("intents.admitted");
  notify(row);
  void matcher.onNew(row);
  return reply.code(201).header("content-type", "application/json").send(body);
});

app.get("/v1/intents/:id", async (req, reply) => {
  const r = store.getIntent((req.params as { id: string }).id);
  return r ? json(reply, 200, intentWire(r)) : json(reply, 404, err("NOT_FOUND", "No such request"));
});

/** Cancel requires a personal_sign of "DIME cancel request <id>" by the intent's wallet. */
app.post("/v1/intents/:id/cancel", { preHandler: authenticate, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const sig = (req.body as { signature?: string } | undefined)?.signature;
  const r = store.getIntent(id);
  if (!r) return json(reply, 404, err("NOT_FOUND", "No such request"));
  if (!sig || !(await verifyMessage({ address: r.user as Address, message: `DIME cancel request ${id}`, signature: sig as Hex }))) {
    return json(reply, 401, err("BAD_SIGNATURE", "Cancellation must be signed by the requesting wallet"));
  }
  if (TERMINAL.includes(r.status)) return json(reply, 409, err("TERMINAL", `Already ${r.status}`));
  if (!store.transition(id, ["MATCHING"], "CANCELLED", { reason: "Cancelled by you. Nothing was opened." })) {
    return json(reply, 409, err("TOO_LATE", "Already submitted; you can still invalidate the nonce on-chain with cancelNonce"));
  }
  notify(store.getIntent(id)!);
  return json(reply, 200, intentWire(store.getIntent(id)!));
});

/* ---------------------------------------------------------------- close */
/** Rounds searched after receipt; the contract allows any round within CLOSE_REQUEST_MAX_AGE_MS (30 s) of the request. */
const CLOSE_ROUND_SLACK = 8;
/** A signed request time may be this old on arrival (wallet approval), leaving room inside the contract's 30 s. */
const CLOSE_REQUEST_MAX_LAG_MS = 25_000;
const CLOSE_REQUEST_FUTURE_MS = 2_000;
app.post("/v1/close", { preHandler: authenticate, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
  const t0 = performance.now();
  const key = String(req.headers["idempotency-key"] ?? "");
  if (!key) return json(reply, 400, err("BAD_REQUEST", "Idempotency-Key header required"));
  const prior = store.idem(`close:${key}`);
  if (prior) return reply.code(200).header("content-type", "application/json").send(prior);
  const b = req.body as { message?: Record<string, string>; signature?: string };
  if (!b?.message || !b.signature) return json(reply, 400, err("BAD_REQUEST", "message and signature required"));
  if (!b.message.requestedAtMs) return json(reply, 400, err("BAD_REQUEST", "requestedAtMs required"));
  const m = {
    user: b.message.user as Address, positionId: b.message.positionId as Hex, requestedAtMs: BigInt(b.message.requestedAtMs),
    expiry: BigInt(b.message.expiry), nonce: BigInt(b.message.nonce),
  };
  // Settlement price = the first signed round after the server RECEIVED the request (and after the signed
  // request time), so back-dating the signed time cannot reach a historical round (audit H-01). The signed
  // time only has to be recent enough to cover wallet approval.
  const receivedAt = Date.now();
  const reqMs = Number(m.requestedAtMs);
  if (reqMs > receivedAt + CLOSE_REQUEST_FUTURE_MS || receivedAt - reqMs > CLOSE_REQUEST_MAX_LAG_MS) {
    return json(reply, 400, err("BAD_REQUEST_TIME", "That close request is out of date. Please try again (and check your device clock)."));
  }
  if (!(await verifyClose(c, m, b.signature as Hex))) return json(reply, 401, err("BAD_SIGNATURE", "Signature does not match"));
  // Closes jump the queue (priority 0); the round is looked up at send time, waiting for it if needed.
  const res = await relayer.submit("CLOSE", m.positionId, "close", async () => {
    const r0 = roundOf(Math.max(receivedAt, reqMs));
    for (let i = 0; i < 25; i++) {
      const p = await prices.proofAfter(r0, CLOSE_ROUND_SLACK);
      if (p) return [m, b.signature, { payload: p.payload }];
      await new Promise((ok) => setTimeout(ok, 100));
    }
    return null;
  }, { priority: 0, deadlineMs: 20_000 });
  metrics.close.record(performance.now() - t0);
  if (res.status === "FAILED") return json(reply, 409, err("REJECTED", closeFailure(res.revert, res.error), { revert: res.revert }));
  const body = toWire({ txHash: res.hash, status: res.status, block: res.block });
  store.saveIdem(`close:${key}`, body);
  return reply.code(200).header("content-type", "application/json").send(body);
});

/* ---------------------------------------------------------------- terms of use */
app.get("/v1/terms/:address", async (req, reply) => {
  const { address } = req.params as { address: string };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return json(reply, 400, err("BAD_ADDRESS", "Expected a 0x address"));
  return json(reply, 200, { version: TERMS_VERSION, accepted: store.hasAcceptedTerms(address, TERMS_VERSION) });
});
app.post("/v1/terms", async (req, reply) => {
  const b = req.body as { address?: string; signature?: string } | undefined;
  if (!b?.address || !/^0x[0-9a-fA-F]{40}$/.test(b.address) || !b.signature || !/^0x[0-9a-fA-F]+$/.test(b.signature)) {
    return json(reply, 400, err("BAD_REQUEST", "address and signature required"));
  }
  // The wallet must sign the exact current terms text (EOA or smart wallet via the public client).
  const ok = await c.pub.verifyMessage({ address: b.address as Address, message: termsMessage(b.address), signature: b.signature as Hex }).catch(() => false);
  if (!ok) return json(reply, 401, err("BAD_SIGNATURE", "Signature does not match the current terms"));
  store.acceptTerms(b.address, TERMS_VERSION, b.signature);
  return json(reply, 200, { version: TERMS_VERSION, accepted: true });
});

const accessView = (address: string) => ({
  termsVersion: TERMS_VERSION, terms: store.hasAcceptedTerms(address, TERMS_VERSION),
  inviteOnly, invited: !inviteOnly || store.isInvited(address),
  slotsLeft: inviteOnly ? Math.max(0, cfg.MAX_INVITED - store.invitedCount()) : null, maxWallets: inviteOnly ? cfg.MAX_INVITED : null,
});
app.get("/v1/access/:address", async (req, reply) => {
  const { address } = req.params as { address: string };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return json(reply, 400, err("BAD_ADDRESS", "Expected a 0x address"));
  return json(reply, 200, accessView(address));
});
/** Join the live test: a signature over the current terms proves wallet ownership; the invite code gates a capped number of wallets. */
app.post("/v1/access", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
  const b = req.body as { address?: string; signature?: string; code?: string } | undefined;
  if (!b?.address || !/^0x[0-9a-fA-F]{40}$/.test(b.address) || !b.signature || !/^0x[0-9a-fA-F]+$/.test(b.signature)) {
    return json(reply, 400, err("BAD_REQUEST", "address and signature required"));
  }
  const address = b.address as Address;
  const ok = await c.pub.verifyMessage({ address, message: termsMessage(address), signature: b.signature as Hex }).catch(() => false);
  if (!ok) return json(reply, 401, err("BAD_SIGNATURE", "Signature does not match the current terms"));
  if (inviteOnly && !store.isInvited(address)) {
    if ((b.code ?? "").trim().toUpperCase() !== cfg.INVITE_CODE!.trim().toUpperCase()) return json(reply, 403, err("BAD_INVITE", "That invite code isn't valid"));
    if (!store.invite(address, cfg.MAX_INVITED)) return json(reply, 409, err("FULL", `The live test is full (${cfg.MAX_INVITED} wallets)`));
  }
  store.acceptTerms(address, TERMS_VERSION, b.signature);
  // Gas top-up runs in the background; the response does not wait for the transfer.
  if (faucet && canTrade(address)) void faucet.topUp(address);
  return json(reply, 200, accessView(address));
});

app.get("/v1/indexer", async (_q, reply) => (envio ? json(reply, 200, envio.view()) : json(reply, 503, err("INDEXER_DISABLED", "Indexer not configured"))));
app.get("/v1/activity/:address", async (req, reply) => {
  const { address } = req.params as { address: string };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return json(reply, 400, err("BAD_ADDRESS", "Expected a 0x address"));
  if (!envio) return json(reply, 503, err("INDEXER_DISABLED", "Indexer not configured"));
  return json(reply, 200, { indexedBlock: envio.view(1).indexedBlock, items: envio.activity(address) });
});

/* ---------------------------------------------------------------- metrics */
app.get("/v1/metrics", async (_q, reply) => {
  let pricing: unknown = null;
  try { pricing = await (await fetch(cfg.PRICING_URL.replace(/^ws/, "http").replace("/internal", "/metrics"))).json(); } catch { /* reported as null */ }
  return json(reply, 200, {
    measuredAt: new Date().toISOString(),
    note: "Server-side measurements since process start. Sample counts included; no extrapolation.",
    quoteServerMs: metrics.quote.summary(),
    intentAdmissionMs: metrics.admit.summary(),
    matchWaitMs: matcher.matchWait.summary(),
    admitToOpenedMs: matcher.admitToOpen.summary(),
    relayerSendToInclusionMs: relayer.sendToInclusion.summary(),
    closeRequestToResultMs: metrics.close.summary(),
    outcomes: { ...matcher.outcomes.toJSON(), ...metrics.counters.toJSON() },
    pricing,
  });
});

/* ---------------------------------------------------------------- websocket */
app.register(async (f) => {
  f.get("/v1/stream", { websocket: true }, (socket: WebSocket) => {
    const mine = new Set<string>();
    socket.on("message", (buf: Buffer) => {
      let m: { op?: string; channel?: string };
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.op === "subscribe" && typeof m.channel === "string" && /^(price:BTC-USD|(intents|settlements|tx):0x[0-9a-fA-F]{40})$/.test(m.channel)) {
        const ch = m.channel.toLowerCase().replace("price:btc-usd", "price:BTC-USD");
        if (mine.size >= 8) return;
        mine.add(ch);
        if (!channels.has(ch)) channels.set(ch, new Set());
        channels.get(ch)!.add(socket);
        if (ch === "price:BTC-USD" && prices.snapshot) socket.send(toWire({ channel: ch, data: prices.snapshot }));
        if (ch.startsWith("intents:")) { const r = store.latestIntentForUser(ch.slice(8)); if (r) socket.send(toWire({ channel: ch, data: intentWire(r) })); }
      }
    });
    socket.on("close", () => { for (const ch of mine) channels.get(ch)?.delete(socket); });
  });
});

await app.listen({ port: cfg.API_PORT, host: cfg.API_HOST });
log.info({ port: cfg.API_PORT, relayer: relayer.address, chainId: cfg.CHAIN_ID, stage: cfg.manifest.stage }, "api up");

// Recover requests that were mid-flight when the process stopped: resolve journalled transactions first,
// then settle every SUBMITTED request from chain state (audit M-03).
await relayer.reconcile().catch((e) => log.error({ err: (e as Error).message }, "startup reconcile failed"));
await sweepSubmitted(0);
process.on("SIGTERM", async () => { watcher.stop(); prices.close(); await app.close(); process.exit(0); });
export { revertName };
