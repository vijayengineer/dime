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

  constructor(token: string, chainId: number, private contracts: Record<string, Address>, fromBlock: bigint, private chainHead: () => Promise<bigint>) {
    this.rpc = createPublicClient({ transport: http(`https://${chainId}.rpc.hypersync.xyz/${token}`) }) as PublicClient;
    this.next = fromBlock;
    this.names = new Map(Object.entries(contracts).map(([n, a]) => [a.toLowerCase(), n]));
  }

  start(intervalMs = 2000) {
    const tick = async () => {
      try { await this.poll(); this.error = null; }
      catch (e) { this.error = "indexer query failed"; log.warn({ err: (e as Error).message.split("\n")[0] }, "envio poll failed"); }
      setTimeout(tick, intervalMs);
    };
    void tick();
  }

  private async poll() {
    const [tip, head] = await Promise.all([this.rpc.getBlockNumber(), this.chainHead()]);
    this.head = head;
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
