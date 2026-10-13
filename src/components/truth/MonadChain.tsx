"use client";

import { useEffect, useState } from "react";
import { createPublicClient, http, type PublicClient } from "viem";
import { dimeAbi } from "@shared/abi";
import { MAINNET } from "@/config/mainnet";
import { shortHash, usd } from "../format";
import { Prov } from "../ui";

/**
 * Live Monad mainnet view, read straight from the public RPC (independent of app mode):
 * recent blocks, throughput, base fee, the MON price, and the deployed DIME contract's state.
 */

interface Blk { number: bigint; hash: string; ts: number; txs: number; gasUsed: bigint; gasLimit: bigint; baseFee: bigint }

const SHOW = 28; // tiles drawn
const KEEP = 150; // blocks kept for rate stats (~1 min); timestamps are whole seconds, so short windows are noisy
const STATES = ["OPEN", "CLOSE_ONLY", "ORACLE_HOLD", "WIND_DOWN", "INSOLVENT"] as const;

let client: PublicClient | null = null;
const rpc = () => (client ??= createPublicClient({ transport: http(MAINNET.rpcUrl, { batch: true }) }) as PublicClient);

function useMonadBlocks() {
  const [blocks, setBlocks] = useState<Blk[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, last = 0n, timer: ReturnType<typeof setTimeout>;
    const toBlk = (b: Awaited<ReturnType<PublicClient["getBlock"]>>): Blk => ({
      number: b.number!, hash: b.hash!, ts: Number(b.timestamp), txs: b.transactions.length,
      gasUsed: b.gasUsed, gasLimit: b.gasLimit, baseFee: b.baseFeePerGas ?? 0n,
    });
    async function tick() {
      try {
        const head = toBlk(await rpc().getBlock({ blockTag: "latest" }));
        if (head.number > last) {
          // Fill short gaps so the lane stays contiguous; after a long pause just restart from head.
          const from = last && head.number - last <= 6n ? last + 1n : head.number;
          const gap = [];
          for (let n = from; n < head.number; n++) gap.push(rpc().getBlock({ blockNumber: n }).then(toBlk));
          const fresh = [...(await Promise.all(gap)), head];
          if (!alive) return;
          last = head.number;
          setBlocks((prev) => {
            const base = prev.length && fresh[0].number === prev[prev.length - 1].number + 1n ? prev : [];
            return [...base, ...fresh].slice(-KEEP);
          });
          setError(null);
        }
      } catch (e) { if (alive) setError((e as Error).message.split("\n")[0]); }
      if (alive) timer = setTimeout(tick, document.hidden ? 5000 : 450); // back off in background tabs
    }
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  return { blocks, error };
}

/** MON perp on Hyperliquid: size-weighted microprice of the top of book. */
function useMonPrice() {
  const [px, setPx] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "l2Book", coin: "MON" }),
        });
        const j = await r.json() as { levels: { px: string; sz: string }[][] };
        const [bid, ask] = [j.levels[0][0], j.levels[1][0]];
        const b = +bid.px, a = +ask.px, bs = +bid.sz, as = +ask.sz;
        if (alive) setPx(bs + as > 0 ? (b * as + a * bs) / (bs + as) : (b + a) / 2);
      } catch { if (alive) setPx(null); }
    }
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return px;
}

interface DimeOnchain { state: number; reserve: bigint; capacity: bigint; openHouse: bigint; openPairs: bigint; allowlist: boolean; epoch: bigint }

function useDimeOnchain() {
  const [v, setV] = useState<DimeOnchain | null>(null);
  useEffect(() => {
    let alive = true;
    const c = { address: MAINNET.protocol, abi: dimeAbi } as const;
    async function load() {
      try {
        const [state, stats, allowlist, epoch] = await Promise.all([
          rpc().readContract({ ...c, functionName: "protocolState" }),
          rpc().readContract({ ...c, functionName: "houseStats" }),
          rpc().readContract({ ...c, functionName: "allowlistEnabled" }),
          rpc().readContract({ ...c, functionName: "epoch" }),
        ]);
        if (alive) setV({
          state: Number(state), reserve: stats.reserve, capacity: stats.availableCapacity,
          openHouse: BigInt(stats.openHousePositions), openPairs: BigInt(stats.openMatchedPairs), allowlist, epoch: BigInt(epoch),
        });
      } catch { /* keep last value; the block lane shows RPC errors */ }
    }
    load();
    const id = setInterval(load, 6000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return v;
}

export function MonadChain() {
  const { blocks, error } = useMonadBlocks();
  const mon = useMonPrice();
  const dime = useDimeOnchain();

  const head = blocks[blocks.length - 1];
  const first = blocks[0];
  const span = head && first ? head.ts - first.ts : 0;
  const nBlocks = head && first ? Number(head.number - first.number) : 0;
  const blockTime = span > 0 && nBlocks > 0 ? span / nBlocks : null;
  const tps = span > 0 ? blocks.slice(1).reduce((s, b) => s + b.txs, 0) / span : null;
  const lane = blocks.slice(-SHOW);
  const maxTxs = Math.max(1, ...lane.map((b) => b.txs));
  const gasPct = head ? Number((head.gasUsed * 10000n) / (head.gasLimit || 1n)) / 100 : null;
  const gwei = head ? Number(head.baseFee) / 1e9 : null;
  const transferUsd = head && mon ? (Number(head.baseFee) * 21000 / 1e18) * mon : null;

  return (
    <section className="card monad-card" aria-labelledby="chain-title">
      <div className="card-title">
        <h2 id="chain-title">Monad mainnet, live</h2>
        <span className="tag" style={{ display: "inline-flex", gap: 6 }}><i className={`pulse ${error ? "off" : ""}`} aria-hidden />{error ? "RPC unreachable" : "streaming blocks"}</span>
      </div>

      <div className="stat-row">
        <Stat label="Head block" value={head ? `#${head.number.toLocaleString()}` : "…"} />
        <Stat label="Block time" value={blockTime ? `${blockTime.toFixed(2)} s` : "…"} hint={`averaged over ${nBlocks || "…"} blocks`} />
        <Stat label="Throughput" value={tps != null ? `${tps.toFixed(1)} tx/s` : "…"} />
        <Stat label="Base fee" value={gwei != null ? `${gwei.toFixed(0)} gwei` : "…"} hint={gasPct != null ? `last block ${gasPct.toFixed(1)}% full` : undefined} />
        <Stat label="MON" value={mon ? `$${mon.toFixed(mon < 1 ? 5 : 3)}` : "…"} hint="Hyperliquid perp microprice" />
        <Stat label="A transfer costs" value={transferUsd != null ? `$${transferUsd < 0.001 ? transferUsd.toFixed(6) : transferUsd.toFixed(4)}` : "…"} hint="21k gas × base fee × MON" />
      </div>

      <div className="block-lane" role="img" aria-label={head ? `Last ${lane.length} Monad blocks up to ${head.number}. Bar height is transaction count.` : "Loading Monad blocks"}>
        {lane.map((b, i) => (
          <div key={b.hash} className={`blk ${i === lane.length - 1 ? "head" : ""}`}
            title={`#${b.number} · ${b.txs} txs · ${(Number((b.gasUsed * 1000n) / (b.gasLimit || 1n)) / 10).toFixed(1)}% gas · ${shortHash(b.hash)}`}>
            <span className="fill" style={{ height: `${Math.max(4, (b.txs / maxTxs) * 100)}%` }} />
            <span className="txs num">{b.txs}</span>
          </div>
        ))}
      </div>
      <div className="lane-axis note"><span>older</span><span>bar height = transactions per block</span><span>newest →</span></div>

      <div className="chalk-rule" />
      <div className="card-title" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>DIME contract on Monad</h3>
        <Prov p="CONFIRMED" />
      </div>
      <dl className="kv">
        <dt>Protocol</dt>
        <dd><a href={`${MAINNET.explorer}/address/${MAINNET.protocol}`} target="_blank" rel="noreferrer">{shortHash(MAINNET.protocol)} ↗</a></dd>
        <dt>State</dt><dd>{dime ? STATES[dime.state]?.replace("_", " ") ?? dime.state : "…"}</dd>
        <dt>House reserve</dt><dd>{dime ? usd(dime.reserve) : "…"}</dd>
        <dt>Open positions</dt><dd>{dime ? `${dime.openHouse} house · ${dime.openPairs} matched pairs` : "…"}</dd>
        <dt>Access</dt><dd>{dime ? (dime.allowlist ? "Founder allow-list (commissioning)" : "Open") : "…"}</dd>
        <dt>Rewards epoch</dt><dd>{dime ? dime.epoch.toString() : "…"}</dd>
      </dl>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="note" style={{ margin: "2px 0 0", fontSize: 11 }}>{hint}</div>}
    </div>
  );
}
