import http from "node:http";
import { loadConfig, readKey } from "../config";
import { log } from "../log";
import { Counters } from "../metrics";
import { Store } from "../store/db";
import { PriceClient } from "../pricing/client";
import { makeChain, PROTOCOL_STATES } from "../chain/chain";
import { Executor } from "../chain/executor";
import { EventWatcher } from "../chain/events";

/**
 * Keeper: liquidations, reserve protection, epoch funding and WIND_DOWN batches.
 * All of these are permissionless on-chain; the contract re-checks every condition, so a
 * keeper bug can waste gas but cannot settle a position that is not eligible.
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
let lastTick = 0;

async function tick() {
  lastTick = Date.now();
  const [cfgOnChain, st, epochStart, block] = await Promise.all([
    c.pub.readContract({ ...c.protocol, functionName: "activeConfig" }),
    c.pub.readContract({ ...c.protocol, functionName: "protocolState" }),
    c.pub.readContract({ ...c.protocol, functionName: "epochStartedAt" }),
    c.pub.getBlock(),
  ]);
  const state = PROTOCOL_STATES[st];
  const proof = prices.freshProof(2000);
  // Attach the price when the tx is sent, not when it was queued: a liquidation is judged at the
  // freshest verified price, so a recovered price makes it revert instead of closing someone late.
  const fresh = () => ({ payload: (prices.freshProof(2000) ?? proof!).payload });

  // Chain time, not wall clock: the contract checks block.timestamp.
  if (block.timestamp >= epochStart + cfgOnChain.epochSeconds && !inFlight.has("epoch")) {
    inFlight.add("epoch");
    exec.submit("FUND_EPOCH", "epoch", "fundAndAdvance", []).then((r) => { counters.inc(`epoch.${r.status}`); log.info({ r }, "fundAndAdvance"); }).finally(() => inFlight.delete("epoch"));
  }
  if (!proof || state === "ORACLE_HOLD") return;
  const px = BigInt(proof.price);
  const open = store.openPositions();

  if (state === "WIND_DOWN") {
    const ids = open.filter((p) => !inFlight.has(p.id)).slice(0, 20).map((p) => p.id as `0x${string}`);
    if (ids.length) {
      ids.forEach((i) => inFlight.add(i));
      exec.submit("LIQUIDATE", ids.join(","), "windDownSettle", () => [ids, fresh()]).finally(() => ids.forEach((i) => inFlight.delete(i)));
    }
    return;
  }

  for (const p of open) {
    if (inFlight.has(p.id)) continue;
    const liq = BigInt(p.liq);
    const isLong = p.side === 0;
    if (isLong ? px <= liq : px >= liq) {
      inFlight.add(p.id);
      exec.submit("LIQUIDATE", p.id, "liquidate", () => [p.id, fresh()])
        .then((r) => { counters.inc(`liquidate.${r.status}`); log.info({ id: p.id, status: r.status, revert: r.revert }, "liquidate"); })
        .finally(() => inFlight.delete(p.id));
      continue;
    }
    if (p.route === "HOUSE") {
      const entry = BigInt(p.entry);
      const notional = BigInt(p.collateral) * BigInt(p.leverage);
      const raw = ((isLong ? px - entry : entry - px) * notional) / entry;
      if (raw * 10_000n >= BigInt(p.reservation) * BigInt(cfgOnChain.protectionTriggerBps)) {
        inFlight.add(p.id);
        exec.submit("PROTECT", p.id, "protect", () => [p.id, fresh()])
          .then((r) => { counters.inc(`protect.${r.status}`); log.info({ id: p.id, status: r.status }, "protect"); })
          .finally(() => inFlight.delete(p.id));
      }
    }
  }
}

setInterval(() => void tick().catch((e) => log.error({ err: e.message }, "keeper tick failed")), cfg.KEEPER_INTERVAL_MS);
setInterval(() => void exec.reconcile(), 10_000);

const port = Number(process.env.KEEPER_PORT ?? 8730);
http.createServer((req, res) => {
  const ok = Date.now() - lastTick < cfg.KEEPER_INTERVAL_MS * 5;
  res.writeHead(req.url === "/health" ? (ok ? 200 : 503) : 404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, lastTick, address: exec.address, openPositions: store.openPositions().length, indexedBlock: String(watcher.lastBlock), counters: counters.toJSON() }));
}).listen(port, "127.0.0.1", () => log.info({ port, keeper: exec.address }, "keeper up"));
