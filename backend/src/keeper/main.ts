import http from "node:http";
import type { Hex } from "viem";
import { loadConfig, readKey } from "../config";
import { log } from "../log";
import { Counters } from "../metrics";
import { Store, type PositionRow } from "../store/db";
import { PriceClient, ROUND_MS } from "../pricing/client";
import { makeChain, PROTOCOL_STATES } from "../chain/chain";
import { Executor } from "../chain/executor";
import { EventWatcher } from "../chain/events";

/**
 * Keeper: liquidations, reserve protection, committed direct closes, epoch funding, WIND_DOWN batches and
 * a liveness heartbeat. Liquidation / protection / wind-down are KEEPER_ROLE-only on-chain while the keeper
 * is live (audit H-01); every action builds its price proof at send time and re-checks its condition
 * against that proof (audit M-05). The contract re-checks everything, so a keeper bug wastes gas at worst.
 *
 * Health (audit M-07) reports whether the keeper can ACT, not just that it is ticking: last successful
 * chain read, a settlement-grade price, signer gas, queue age and recent action failures.
 */
const cfg = loadConfig();
const store = new Store(process.env.KEEPER_DB_PATH ?? "./data/keeper.sqlite");
const c = makeChain(cfg);
const prices = new PriceClient(cfg.PRICING_URL);
const exec = new Executor(store, c, readKey(cfg.KEEPER_KEY_FILE, "keeper"), "keeper");
const watcher = new EventWatcher(c, store, cfg.manifest.deploymentBlock, "keeper.cursor");
watcher.start();
const counters = new Counters();
const inFlight = new Set<string>();
const HEARTBEAT_MS = Number(process.env.KEEPER_HEARTBEAT_MS ?? 20 * 60_000);
const MIN_GAS_WEI = BigInt(process.env.KEEPER_MIN_GAS_WEI ?? "50000000000000000"); // 0.05 MON
const CLOSE_ROUND_SLACK = 8; // DimeProtocol.CLOSE_ROUND_SLACK
const COMMIT_ROUND_SECONDS = 10; // DimeProtocol.COMMIT_ROUND_SECONDS

const health = {
  lastTick: 0, lastChainReadOk: 0, lastProofOk: 0, lastHeartbeatOk: 0, gasWei: -1n, gasCheckedAt: 0,
  consecutiveFailures: 0, lastFailure: null as null | { at: number; kind: string; error: string }, lastActionOk: 0,
};

function track(kind: string, p: Promise<{ status: string; revert?: string | null; error?: string }>, id: string) {
  inFlight.add(id);
  p.then((r) => {
    counters.inc(`${kind}.${r.status}`);
    const benign = r.revert === "NotLiquidatable" || r.revert === "NotTriggered" || r.revert === "UnknownPosition" || r.error?.includes("condition cleared");
    if (r.status === "INCLUDED" || benign) { health.consecutiveFailures = 0; health.lastActionOk = Date.now(); }
    else { health.consecutiveFailures++; health.lastFailure = { at: Date.now(), kind, error: r.revert ?? r.error ?? r.status }; }
    log.info({ kind, id, status: r.status, revert: r.revert }, kind);
  }).finally(() => inFlight.delete(id));
}

const settleProof = () => { const p = prices.freshProof(2000, "settle"); return p ? { payload: p.payload, price: BigInt(p.price) } : null; };
const liquidatable = (p: PositionRow, px: bigint) => (p.side === 0 ? px <= BigInt(p.liq) : px >= BigInt(p.liq));
const protectDue = (p: PositionRow, px: bigint, triggerBps: number) => {
  const entry = BigInt(p.entry), notional = BigInt(p.collateral) * BigInt(p.leverage);
  const raw = ((p.side === 0 ? px - entry : entry - px) * notional) / entry;
  return raw * 10_000n >= BigInt(p.reservation) * BigInt(triggerBps);
};

async function tick() {
  health.lastTick = Date.now();
  const [cfgOnChain, st, epochStart, block, lastBeat] = await Promise.all([
    c.pub.readContract({ ...c.protocol, functionName: "activeConfig" }),
    c.pub.readContract({ ...c.protocol, functionName: "protocolState" }),
    c.pub.readContract({ ...c.protocol, functionName: "epochStartedAt" }),
    c.pub.getBlock(),
    c.pub.readContract({ ...c.protocol, functionName: "lastKeeperHeartbeat" }),
  ]);
  health.lastChainReadOk = Date.now();
  if (Date.now() - health.gasCheckedAt > 30_000) { health.gasWei = await c.pub.getBalance({ address: exec.address }); health.gasCheckedAt = Date.now(); }
  const state = PROTOCOL_STATES[st];
  if (settleProof()) health.lastProofOk = Date.now();

  // Chain time, not wall clock: the contract checks block.timestamp.
  if (block.timestamp >= epochStart + cfgOnChain.epochSeconds && !inFlight.has("epoch")) {
    track("epoch", exec.submit("FUND_EPOCH", "epoch", "fundAndAdvance", [], { priority: 1 }), "epoch");
  }
  // Liveness: keeps the permissionless escape hatch closed while we are healthy.
  if ((Number(block.timestamp) - Number(lastBeat)) * 1000 >= HEARTBEAT_MS && !inFlight.has("heartbeat")) {
    track("heartbeat", exec.submit("HEARTBEAT", "heartbeat", "keeperHeartbeat", [], { priority: 0 }).then((r) => {
      if (r.status === "INCLUDED") health.lastHeartbeatOk = Date.now();
      return r;
    }), "heartbeat");
  }
  if (state === "ORACLE_HOLD") return;
  const open = store.openPositions();

  if (state === "WIND_DOWN") {
    const ids = open.filter((p) => !inFlight.has(p.id)).slice(0, 20).map((p) => p.id as Hex);
    if (ids.length) {
      const key = ids.join(",");
      track("windDown", exec.submit("LIQUIDATE", key, "windDownSettle", () => { const p = settleProof(); return p ? [ids, { payload: p.payload }] : null; }, { priority: 0, deadlineMs: 10_000 }), key);
    }
    return;
  }

  for (const p of open) {
    if (inFlight.has(p.id)) continue;
    // A direct close the owner committed on-chain: settle at the first round after the commit block.
    if (p.close_commit) {
      const commit = p.close_commit;
      const firstRound = Math.floor(((commit + 1) * 1000) / ROUND_MS);
      track("settleClose", exec.submit("SETTLE_CLOSE", p.id, "settleCommittedClose", async () => {
        // Within COMMIT_ROUND_SECONDS: the first rounds after the commit. Later: a fresh price (contract fallback).
        if (Date.now() / 1000 <= commit + COMMIT_ROUND_SECONDS) {
          const proof = await prices.proofAfter(firstRound - 1, CLOSE_ROUND_SLACK);
          if (proof) return [p.id, { payload: proof.payload }];
          return null;
        }
        const fresh = settleProof();
        return fresh ? [p.id, { payload: fresh.payload }] : null;
      }, { priority: 0, deadlineMs: 15_000 }), p.id);
      continue;
    }
    const now = settleProof();
    if (!now) continue;
    if (liquidatable(p, now.price)) {
      track("liquidate", exec.submit("LIQUIDATE", p.id, "liquidate", () => {
        const fresh = settleProof();
        return fresh && liquidatable(p, fresh.price) ? [p.id, { payload: fresh.payload }] : null; // re-check at send time
      }, { priority: 0, deadlineMs: 10_000 }), p.id);
      continue;
    }
    if (p.route === "HOUSE" && protectDue(p, now.price, cfgOnChain.protectionTriggerBps)) {
      track("protect", exec.submit("PROTECT", p.id, "protect", () => {
        const fresh = settleProof();
        return fresh && protectDue(p, fresh.price, cfgOnChain.protectionTriggerBps) ? [p.id, { payload: fresh.payload }] : null;
      }, { priority: 0, deadlineMs: 10_000 }), p.id);
    }
  }
}

setInterval(() => void tick().catch((e) => log.error({ err: e.message }, "keeper tick failed")), cfg.KEEPER_INTERVAL_MS);
setInterval(() => void exec.reconcile(), 5_000);

/** Can the keeper act right now? Idle is healthy; unable-to-act is not (audit M-07). */
function status() {
  const now = Date.now();
  const open = store.openPositions().length;
  const problems: string[] = [];
  if (now - health.lastChainReadOk > 30_000) problems.push("chain reads failing");
  if (open > 0 && now - health.lastProofOk > 10_000) problems.push("no settlement-grade price");
  if (health.gasWei >= 0n && health.gasWei < MIN_GAS_WEI) problems.push("keeper gas low");
  if (exec.oldestQueuedMs > 60_000) problems.push("keeper queue stuck");
  if (health.consecutiveFailures >= 3) problems.push("required actions failing");
  return { ok: problems.length === 0, state: problems.length ? "UNABLE_TO_ACT" : open ? "WATCHING" : "IDLE", problems, open };
}

const port = Number(process.env.KEEPER_PORT ?? 8730);
http.createServer((req, res) => {
  const s = status();
  res.writeHead(req.url === "/health" ? (s.ok ? 200 : 503) : 404, { "content-type": "application/json" });
  res.end(JSON.stringify({
    ...s, address: exec.address, lastTick: health.lastTick, lastChainReadOk: health.lastChainReadOk, lastProofOk: health.lastProofOk,
    lastHeartbeatOk: health.lastHeartbeatOk, gasWei: health.gasWei.toString(), queueDepth: exec.queueDepth, oldestQueuedMs: exec.oldestQueuedMs,
    consecutiveFailures: health.consecutiveFailures, lastFailure: health.lastFailure, lastActionOk: health.lastActionOk,
    indexedBlock: String(watcher.lastBlock), counters: counters.toJSON(),
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}).listen(port, "127.0.0.1", () => log.info({ port, keeper: exec.address }, "keeper up"));
