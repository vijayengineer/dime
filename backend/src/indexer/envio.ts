import { createPublicClient, decodeEventLog, http, type Address, type PublicClient } from "viem";
import { dimeAbi, dimeTokenAbi, priceVerifierAbi } from "../../../shared/abi";
import { log } from "../log";

/**
 * Indexes DIME contract events from Monad through Envio HyperRPC (eth_getLogs). The token stays
 * server-side; browsers read the result from /v1/indexer. Contract state remains authoritative.
 */

export interface IndexedEvent { block: bigint; ts: number; tx: string; logIndex: number; contract: string; event: string }

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

const KEEP = 200;
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

  constructor(token: string, chainId: number, private contracts: Record<string, Address>, fromBlock: bigint, private chainHead: () => Promise<bigint>) {
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
        for (const abi of [dimeAbi, dimeTokenAbi, priceVerifierAbi]) {
          try { event = decodeEventLog({ abi, data: l.data, topics: l.topics }).eventName as string; break; } catch { /* try next abi */ }
        }
        const ts = Number((l as unknown as { blockTimestamp?: string }).blockTimestamp ?? 0) * 1000;
        this.log.push({ block: l.blockNumber!, ts, tx: l.transactionHash!, logIndex: l.logIndex!, contract: this.names.get(l.address.toLowerCase()) ?? l.address, event });
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

  view(limit = 20): IndexerView {
    return {
      source: "Envio HyperRPC",
      indexedBlock: this.indexed, chainHead: this.head,
      lagBlocks: this.indexed != null && this.head != null ? Math.max(0, Number(this.head - this.indexed)) : null,
      events: this.total, recent: this.log.slice(-limit).reverse(), updatedAt: this.updatedAt, error: this.error,
    };
  }
}
