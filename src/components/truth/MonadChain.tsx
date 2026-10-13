"use client";

import { useEffect, useState } from "react";
import { createPublicClient, encodeAbiParameters, http, type Hex, type PublicClient } from "viem";
import { dimeAbi, priceVerifierAbi } from "@shared/abi";
import { MAINNET } from "@/config/mainnet";
import { ago, price, shortHash, time, usd } from "../format";
import { Prov } from "../ui";

/**
 * Live view of DIME on Monad mainnet, read from the public RPC whatever the app mode:
 * each operator-signed BTC price is checked by the deployed verifier contract (eth_call),
 * plus chain stats, the MON price and the protocol's on-chain state.
 */

const SHOW = 32; // verified prices drawn
const STATES = ["OPEN", "CLOSE_ONLY", "ORACLE_HOLD", "WIND_DOWN", "INSOLVENT"] as const;

let client: PublicClient | null = null;
const rpc = () => (client ??= createPublicClient({ transport: http(MAINNET.rpcUrl, { batch: true }) }) as PublicClient);
const backoff = () => (document.hidden ? 5000 : 1000); // slow down in background tabs

interface Verified { price: bigint; tsMs: number; ok: boolean; block: bigint | null; checkMs: number; sig: Hex }

/** Signed prices from the public audit log, each checked by OperatorPriceVerifier.verify on Monad. */
function useVerifiedPrices() {
  const [items, setItems] = useState<Verified[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, lastTs = 0, market: Hex | null = null, timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        market ??= await rpc().readContract({ address: MAINNET.protocol, abi: dimeAbi, functionName: "BTC_MARKET" });
        const r = await fetch(`${MAINNET.api}/feed/audit?limit=1`);
        const rec = ((await r.json()) as { records: { tsMs: number; price: string; sig: Hex }[] }).records.at(-1);
        if (rec && rec.tsMs > lastTs) {
          lastTs = rec.tsMs;
          const payload = encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }, { type: "bytes" }], [BigInt(rec.price), BigInt(rec.tsMs), rec.sig]);
          const t0 = performance.now();
          const [ok, block] = await Promise.all([
            rpc().readContract({ address: MAINNET.verifier, abi: priceVerifierAbi, functionName: "verify", args: [market, payload] })
              .then(([p, ts]) => p === BigInt(rec.price) && Number(ts) === rec.tsMs).catch(() => false),
            rpc().getBlockNumber({ cacheTime: 0 }).catch(() => null),
          ]);
          const v: Verified = { price: BigInt(rec.price), tsMs: rec.tsMs, ok, block, checkMs: Math.round(performance.now() - t0), sig: rec.sig };
          if (alive) { setItems((prev) => [...prev, v].slice(-SHOW)); setError(null); }
        }
      } catch (e) { if (alive) setError((e as Error).message.split("\n")[0]); }
      if (alive) timer = setTimeout(tick, backoff());
    }
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  return { items, error };
}

interface Blk { number: bigint; hash: string; ts: number; txs: number; gasUsed: bigint; gasLimit: bigint; baseFee: bigint }

const LANE = 28; // block tiles drawn
const KEEP = 150; // blocks kept for rate stats (~1 min); timestamps are whole seconds, so short windows are noisy

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
          // Fill short gaps so the lane stays contiguous; after a long pause restart from head.
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
      if (alive) timer = setTimeout(tick, document.hidden ? 5000 : 450);
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

interface DimeOnchain { state: number; reserve: bigint; openHouse: bigint; openPairs: bigint; allowlist: boolean; epoch: bigint }

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
          state: Number(state), reserve: stats.reserve, openHouse: BigInt(stats.openHousePositions),
          openPairs: BigInt(stats.openMatchedPairs), allowlist, epoch: BigInt(epoch),
        });
      } catch { /* keep last value */ }
    }
    load();
    const id = setInterval(load, 6000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return v;
}

/** The animation's last hop, for real: each signed price checked by the verifier contract on Monad. */
export function VerifiedStream() {
  const { items, error } = useVerifiedPrices();
  const dime = useDimeOnchain();

  const last = items.at(-1);
  const prices = items.map((v) => v.price);
  const lo = prices.length ? prices.reduce((a, b) => (b < a ? b : a)) : 0n;
  const hi = prices.length ? prices.reduce((a, b) => (b > a ? b : a)) : 0n;
  const height = (p: bigint) => (hi === lo ? 55 : 12 + Number(((p - lo) * 8800n) / (hi - lo)) / 100);
  const passed = items.filter((v) => v.ok).length;

  return (
    <div className="verified-stream" aria-labelledby="chain-title">
      <div className="card-title">
        <h3 id="chain-title">BTC price, verified on Monad</h3>
        <span className="tag" style={{ display: "inline-flex", gap: 6 }}><i className={`pulse ${error ? "off" : ""}`} aria-hidden />{error ? "unreachable" : "streaming"}</span>
      </div>

      <div className="verified-head">
        <div>
          <div className={`verified-num num ${last && !last.ok ? "down" : ""}`}>{last ? price(last.price) : "…"}</div>
          <div className="note" style={{ margin: 0 }}>
            {last
              ? <>{last.ok ? "✓ Accepted" : "✕ Rejected"} by the DIME verifier contract{last.block ? <> at block #{last.block.toLocaleString()}</> : null} · signed {time(last.tsMs)} · check took {ago(last.checkMs)}</>
              : "Waiting for the first signed price…"}
          </div>
        </div>
        <div className="verified-tally num">
          <span className="up">{passed}</span><span className="muted"> / {items.length} verified</span>
        </div>
      </div>

      <div className="block-lane" role="img" aria-label={last ? `Last ${items.length} signed BTC prices, ${passed} accepted by the verifier contract on Monad. Latest ${price(last.price)}.` : "Loading verified prices"}>
        {items.map((v, i) => (
          <div key={v.sig} className={`blk ${i === items.length - 1 ? "head" : ""} ${v.ok ? "" : "bad"}`}
            title={`${price(v.price)} · signed ${time(v.tsMs)} · ${v.ok ? "verified" : "REJECTED"}${v.block ? ` at block #${v.block}` : ""} · sig ${shortHash(v.sig)}`}>
            <span className="fill" style={{ height: `${height(v.price)}%` }} />
          </div>
        ))}
      </div>
      <div className="lane-axis note">
        <span>{prices.length ? `low ${price(lo)}` : ""}</span>
        <span>each bar = one signed price, checked on-chain</span>
        <span>{prices.length ? `high ${price(hi)}` : ""}</span>
      </div>
      <p className="note">
        Each price signed by our pricing service is passed to <code>verify()</code> on the deployed verifier
        (<a href={`${MAINNET.explorer}/address/${MAINNET.verifier}`} target="_blank" rel="noreferrer">{shortHash(MAINNET.verifier)} ↗</a>) as a read call
        at Monad&apos;s latest block. A trade sends the same proof on-chain when it opens or closes.
      </p>

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

    </div>
  );
}

/** Live Monad blocks: one bar per block, height = transactions; chain stats and the MON price above. */
export function MonadBlocks() {
  const { blocks, error } = useMonadBlocks();
  const mon = useMonPrice();
  const head = blocks.at(-1), first = blocks[0];
  const span = head && first ? head.ts - first.ts : 0;
  const nBlocks = head && first ? Number(head.number - first.number) : 0;
  const blockTime = span >= 5 && nBlocks > 0 ? span / nBlocks : null;
  const tps = span >= 5 ? blocks.slice(1).reduce((a, b) => a + b.txs, 0) / span : null;
  const lane = blocks.slice(-LANE);
  const maxTxs = Math.max(1, ...lane.map((b) => b.txs));
  const gasPct = head ? Number((head.gasUsed * 10000n) / (head.gasLimit || 1n)) / 100 : null;
  const gwei = head ? Number(head.baseFee) / 1e9 : null;
  const transferUsd = head && mon ? (Number(head.baseFee) * 21000 / 1e18) * mon : null;

  return (
    <section className="card monad-card" aria-labelledby="blocks-title">
      <div className="card-title">
        <h2 id="blocks-title">Monad mainnet, live</h2>
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
    </section>
  );
}

interface IndexerWire {
  source: string; indexedBlock: string | null; chainHead: string | null; lagBlocks: number | null; events: number;
  recent: { block: string; ts: number; tx: string; logIndex: number; contract: string; event: string }[];
  updatedAt: number | null; error: string | null;
}

/** DIME contract events indexed through Envio (HyperRPC), served by the DIME API. */
export function EnvioIndexer() {
  const [v, setV] = useState<IndexerWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const r = await fetch(`${MAINNET.api}/v1/indexer`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as IndexerWire;
        if (alive) { setV(j); setError(j.error); }
      } catch (e) { if (alive) setError((e as Error).message); }
      if (alive) timer = setTimeout(load, document.hidden ? 15000 : 4000);
    }
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  return (
    <section className="card" aria-labelledby="idx-title">
      <div className="card-title"><h2 id="idx-title">Indexer</h2><Prov p="INDEXED" /></div>
      {!v && !error && <p className="note">Loading…</p>}
      {error && (!v?.updatedAt || Date.now() - v.updatedAt > 60_000) && <p className="warn-box">Indexer behind: {error}</p>}
      {v && (
        <>
          <dl className="kv">
            <dt>Source</dt><dd>{v.source}</dd>
            <dt>Indexed block</dt><dd>{v.indexedBlock ? `#${Number(v.indexedBlock).toLocaleString()}` : "—"}</dd>
            <dt>Chain head</dt><dd>{v.chainHead ? `#${Number(v.chainHead).toLocaleString()}` : "—"}</dd>
            <dt>Lag</dt><dd>{v.lagBlocks ?? "—"} blocks{v.updatedAt ? ` · updated ${ago(Math.max(0, Date.now() - v.updatedAt))} ago` : ""}</dd>
            <dt>DIME events indexed</dt><dd>{v.events}</dd>
          </dl>
          {v.recent.length > 0 && (
            <ul className="list" style={{ marginTop: 10 }}>
              {v.recent.slice(0, 6).map((e) => (
                <li key={`${e.tx}-${e.logIndex}`}>
                  <span className="num muted" style={{ fontSize: 12 }}>#{Number(e.block).toLocaleString()}</span>
                  <span>{e.event}<span className="note" style={{ display: "block" }}>{e.contract}</span></span>
                  <a className="num" href={`${MAINNET.explorer}/tx/${e.tx}`} target="_blank" rel="noreferrer">{shortHash(e.tx)} ↗</a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
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
