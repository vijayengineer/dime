import { formatEther } from "viem";
import { loadConfig, readKey } from "../config";
import { log } from "../log";
import { Store } from "../store/db";
import { makeChain, PROTOCOL_STATES } from "../chain/chain";
import { Executor } from "../chain/executor";

/**
 * Independent watchdog. Escalates only toward LESS risk: if the price reference stays stale
 * while the protocol is OPEN, the guardian moves it to ORACLE_HOLD. Reopening is an admin
 * decision (runbook), never automatic. Alerts are structured error logs (+ optional webhook).
 */
const cfg = loadConfig();
const c = makeChain(cfg);
const guardian = cfg.GUARDIAN_KEY_FILE
  ? new Executor(new Store(process.env.WATCHDOG_DB_PATH ?? "./data/watchdog.sqlite"), c, readKey(cfg.GUARDIAN_KEY_FILE, "guardian"), "guardian")
  : null;
const pricingHttp = cfg.PRICING_URL.replace(/^ws/, "http").replace("/internal", "");
const apiHttp = `http://${cfg.API_HOST}:${cfg.API_PORT}`;
const keeperHttp = `http://127.0.0.1:${process.env.KEEPER_PORT ?? 8730}`;
const MIN_GAS_WEI = BigInt(process.env.WATCHDOG_MIN_GAS_WEI ?? "100000000000000000"); // 0.1 MON
let staleSince: number | null = null;
let held = false;

async function probe(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return { ok: r.ok, body: await r.json().catch(() => null) }; }
  catch (e) { return { ok: false, body: { error: (e as Error).message } }; }
}

async function alert(kind: string, detail: unknown) {
  log.error({ alert: kind, detail }, "WATCHDOG ALERT");
  if (process.env.ALERT_WEBHOOK_URL) await fetch(process.env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, detail, at: new Date().toISOString() }) }).catch(() => {});
}

async function tick() {
  const [pricing, api, keeper] = await Promise.all([probe(`${pricingHttp}/health`), probe(`${apiHttp}/health`), probe(`${keeperHttp}/health`)]);
  const st = PROTOCOL_STATES[await c.pub.readContract({ ...c.protocol, functionName: "protocolState" })];
  const proofAge = (pricing.body as { proofAgeMs?: number } | null)?.proofAgeMs ?? null;
  const priceOk = pricing.ok && proofAge !== null && proofAge < 3000;

  if (!priceOk) {
    staleSince ??= Date.now();
    if (st === "OPEN" && Date.now() - staleSince > cfg.WATCHDOG_STALE_HOLD_MS && !held) {
      await alert("PRICE_STALE", { proofAge, since: staleSince });
      if (guardian) {
        const r = await guardian.submit("SET_STATE", "ORACLE_HOLD", "setProtocolState", [2]);
        held = r.status === "INCLUDED";
        await alert("ORACLE_HOLD_SET", r);
      }
    }
  } else {
    staleSince = null;
    held = false;
  }
  if (!api.ok) await alert("API_DOWN", api.body);
  if (!keeper.ok) await alert("KEEPER_DOWN", keeper.body);
  for (const role of ["relayer", "keeper"] as const) {
    const addr = role === "relayer" ? cfg.manifest.relayer : (keeper.body as { address?: `0x${string}` } | null)?.address;
    if (!addr) continue;
    const bal = await c.pub.getBalance({ address: addr as `0x${string}` });
    if (bal < MIN_GAS_WEI) await alert("LOW_GAS", { role, address: addr, balance: formatEther(bal) });
  }
  const hs = await c.pub.readContract({ ...c.protocol, functionName: "houseStats" });
  if (hs.unfundedLiabilities > 0n || st === "INSOLVENT") await alert("INSOLVENCY", { unfunded: hs.unfundedLiabilities.toString(), state: st });
}

setInterval(() => void tick().catch((e) => log.error({ err: e.message }, "watchdog tick failed")), cfg.WATCHDOG_INTERVAL_MS);
log.info({ guardian: guardian?.address ?? "none (alerts only)" }, "watchdog up");
