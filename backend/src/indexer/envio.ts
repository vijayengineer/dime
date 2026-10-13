import { createPublicClient, decodeEventLog, http, type Address, type PublicClient } from "viem";
import { dimeAbi, dimeTokenAbi, priceVerifierAbi } from "../../../shared/abi";
import { log } from "../log";

/**
 * Indexes DIME contract events from Monad through Envio HyperRPC (eth_getLogs). The token stays
 * server-side; browsers read the result from /v1/indexer. Contract state remains authoritative.
 */

export interface IndexedEvent { block: bigint; ts: number; tx: string; logIndex: number; contract: string; event: string; args?: Record<string, unknown> }

/** Per-user history item, same shape and wording as envio/src/handlers.ts (Activity entity). */
export interface ActivityWire { id: string; kind: string; at: number; title: string; amount?: string; txHash: string; block: string }

const ROUTES = ["MATCHED", "HOUSE"] as const;
const SIDES = ["LONG", "SHORT"] as const;
const REASONS = ["USER", "COUNTERPARTY", "LIQUIDATION", "COUNTERPARTY_LIQUIDATED", "RESERVE_PROTECTION", "EMERGENCY"] as const;
const usd = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;
const dime = (v: bigint) => (Number(v) / 1e18).toFixed(4);

function toActivity(e: IndexedEvent): Omit<ActivityWire, "id" | "at" | "txHash" | "block"> | null {
  const a = (e.args ?? {}) as Record<string, any>;
  switch (e.event) {
    case "Deposited": return { kind: "DEPOSIT", title: `Deposited ${usd(a.amount)}`, amount: String(a.amount) };
    case "Withdrawn": return { kind: "WITHDRAW", title: `Withdrew ${usd(a.amount)}`, amount: String(a.amount) };
    case "IntentCancelled": return { kind: "INTENT_CANCELLED", title: "Request nonce cancelled on-chain" };
    case "PositionOpened": {
      const route = ROUTES[Number(a.route)], side = SIDES[Number(a.side)];
      return { kind: "POSITION_OPENED", title: `Opened ${side.toLowerCase()} · ${route === "HOUSE" ? "house" : "matched"} · ${a.leverage}×`, amount: String(a.collateral) };
    }
    case "PositionSettled": {
      const net = BigInt(a.netPnl), reason = REASONS[Number(a.reason)] ?? "USER";
      const verb = net > 0n ? "net gain" : net < 0n ? "loss" : "flat";
      return { kind: "POSITION_SETTLED", title: `Settled · ${verb} (${reason.toLowerCase().replaceAll("_", " ")})`, amount: String(net) };
    }
    case "DimeIssued": return { kind: "RIGHTS_ISSUED", title: `${dime(a.amount)} DIME issued, auto-staked (active epoch ${a.activationEpoch})`, amount: String(a.amount) };
    case "Staked": return { kind: "STAKE", title: `Staked ${dime(a.amount)} DIME (active epoch ${a.activationEpoch})`, amount: String(a.amount) };
    case "Unstaked": return { kind: "UNSTAKE", title: `Unstaked ${dime(a.amount)} DIME`, amount: String(a.amount) };
    case "Claimed": return { kind: "CLAIM", title: `Claimed ${usd(a.amount)} distribution`, amount: String(a.amount) };
    default: return null;
  }
}

export interface IndexerView {
  source: string;
  indexedBlock: bigint | null;
  chainHead: bigint | null;
  lagBlocks: number | null;
  events: number;
  recent: IndexedEvent[];
  updatedAt: number | null;
  error: string | null;
}

const KEEP = 20_000; // events kept in memory (re-read from the deployment block on restart)
const MAX_RANGE = 50_000n; // blocks per eth_getLogs call
const LOGS_EVERY_MS = 15_000; // HyperRPC rate-limits eth_getLogs; the head is refreshed every tick
const MAX_BACKOFF_MS = 300_000;

export class EnvioIndexer {
  private rpc: PublicClient;
  private next: bigint;
  private log: IndexedEvent[] = [];
  private total = 0;
  private indexed: bigint | null = null;
  private head: bigint | null = null;
  private updatedAt: number | null = null;
  private error: string | null = null;
  private names: Map<string, string>;
  private logsAt = 0;
  private logsEvery = LOGS_EVERY_MS;

  private blockTs = new Map<bigint, number>();

  constructor(
    token: string, chainId: number, private contracts: Record<string, Address>, fromBlock: bigint,
    private chainHead: () => Promise<bigint>, private blockTime: (n: bigint) => Promise<number>,
  ) {
    this.rpc = createPublicClient({ transport: http(`https://${chainId}.rpc.hypersync.xyz/${token}`) }) as PublicClient;
    this.next = fromBlock;
    this.names = new Map(Object.entries(contracts).map(([n, a]) => [a.toLowerCase(), n]));
  }

  start(intervalMs = 2000) {
    const tick = async () => {
      try { await this.poll(); }
      catch (e) {
        this.logsEvery = Math.min(this.logsEvery * 2, MAX_BACKOFF_MS); // back off (e.g. HTTP 429)
        this.error = "indexer query failed, retrying";
        log.warn({ err: (e as Error).message.split("\n")[0], retryMs: this.logsEvery }, "envio poll failed");
      }
      setTimeout(tick, intervalMs);
    };
    void tick();
  }

  private async poll() {
    this.head = await this.chainHead();
    if (Date.now() - this.logsAt < this.logsEvery) return;
    this.logsAt = Date.now();
    const tip = await this.rpc.getBlockNumber({ cacheTime: 0 });
    while (this.next <= tip) {
      const to = this.next + MAX_RANGE - 1n < tip ? this.next + MAX_RANGE - 1n : tip;
      const logs = await this.rpc.getLogs({ address: Object.values(this.contracts), fromBlock: this.next, toBlock: to });
      for (const l of logs) {
        let event = l.topics[0]?.slice(0, 10) ?? "unknown";
        let args: Record<string, unknown> | undefined;
        for (const abi of [dimeAbi, dimeTokenAbi, priceVerifierAbi]) {
          try { const d = decodeEventLog({ abi, data: l.data, topics: l.topics }); event = d.eventName as string; args = d.args as Record<string, unknown>; break; } catch { /* try next abi */ }
        }
        // HyperRPC includes blockTimestamp on most logs; otherwise read it from the chain once per block.
        let ts = Number((l as unknown as { blockTimestamp?: string }).blockTimestamp ?? 0) * 1000;
        if (!ts) {
          ts = this.blockTs.get(l.blockNumber!) ?? (await this.blockTime(l.blockNumber!).catch(() => 0));
          if (ts) this.blockTs.set(l.blockNumber!, ts);
        }
        this.log.push({ block: l.blockNumber!, ts, tx: l.transactionHash!, logIndex: l.logIndex!, contract: this.names.get(l.address.toLowerCase()) ?? l.address, event, args });
        this.total++;
      }
      if (this.log.length > KEEP) this.log = this.log.slice(-KEEP);
      this.next = to + 1n;
    }
    this.indexed = tip;
    this.updatedAt = Date.now();
    this.logsEvery = LOGS_EVERY_MS;
    this.error = null;
  }

  /** History for one wallet, newest first (DIME protocol events only). */
  activity(user: string, limit = 100): ActivityWire[] {
    const u = user.toLowerCase();
    const out: ActivityWire[] = [];
    for (let i = this.log.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.log[i];
      if (e.contract !== "DimeProtocol" || String((e.args as { user?: string } | undefined)?.user ?? "").toLowerCase() !== u) continue;
      const a = toActivity(e);
      if (a) out.push({ ...a, id: `${e.tx}-${e.logIndex}`, at: e.ts, txHash: e.tx, block: e.block.toString() });
    }
    return out;
  }

  view(limit = 20): IndexerView {
    return {
      source: "Envio HyperRPC",
      indexedBlock: this.indexed, chainHead: this.head,
      lagBlocks: this.indexed != null && this.head != null ? Math.max(0, Number(this.head - this.indexed)) : null,
      events: this.total, recent: this.log.slice(-limit).reverse().map(({ args: _args, ...e }) => e), updatedAt: this.updatedAt, error: this.error,
    };
  }
}
