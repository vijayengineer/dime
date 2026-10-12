import { randomUUID } from "node:crypto";
import type { Abi, Hex } from "viem";
import { log } from "../log";
import { Latency } from "../metrics";
import type { Store, TxRow } from "../store/db";
import { revertName, type Chain } from "./chain";

export interface TxResult {
  txId: string;
  status: TxRow["status"];
  hash?: Hex;
  block?: number;
  revert?: string | null;
  error?: string;
}

/**
 * One signer, one in-flight transaction at a time (bounded queue). Every tx is recorded
 * BEFORE it is sent. A timeout marks it UNKNOWN for the reconciler — it is never blindly
 * resubmitted (that could duplicate a position). Simulation runs first to fail fast with the
 * contract's custom error.
 */
export class Executor {
  private chainQ: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private nextNonce: number | null = null;
  readonly sendToInclusion = new Latency();
  readonly address: Hex;
  private client;

  constructor(private store: Store, private c: Chain, key: Hex, readonly role: string, private maxDepth = 200) {
    const w = c.wallet(key);
    this.client = w.client;
    this.address = w.account.address;
  }

  get queueDepth() { return this.depth; }

  submit(kind: TxRow["kind"], ref: string, functionName: string, args: readonly unknown[]): Promise<TxResult> {
    if (this.depth >= this.maxDepth) return Promise.resolve({ txId: "", status: "FAILED", error: "executor queue full" });
    this.depth++;
    const run = this.chainQ.then(() => this.run(kind, ref, functionName, args)).finally(() => { this.depth--; });
    this.chainQ = run.catch(() => undefined);
    return run;
  }

  private async run(kind: TxRow["kind"], ref: string, functionName: string, args: readonly unknown[]): Promise<TxResult> {
    const txId = randomUUID();
    const now = Date.now();
    this.store.insertTx({
      id: txId, kind, ref, sender: this.address, nonce: null, hash: null, status: "PREPARED", error: null,
      block: null, sent_at: null, included_at: null, created_at: now, updated_at: now,
    });
    let request;
    try {
      ({ request } = await this.c.pub.simulateContract({
        ...this.c.protocol, abi: this.c.protocol.abi as Abi, functionName, args: args as unknown[], account: this.client.account,
      }));
    } catch (e) {
      const revert = revertName(e);
      this.store.updateTx(txId, { status: "FAILED", error: revert ?? (e as Error).message.slice(0, 300) });
      return { txId, status: "FAILED", revert, error: revert ?? "simulation failed" };
    }
    try {
      // Estimates can be tight when settlement takes a different branch at inclusion time; add 30%.
      const est = await this.c.pub.estimateContractGas({
        ...this.c.protocol, abi: this.c.protocol.abi as Abi, functionName, args: args as unknown[], account: this.client.account,
      });
      const gas = (est * 13n) / 10n;
      const pending = await this.c.pub.getTransactionCount({ address: this.address, blockTag: "pending" });
      const nonce = this.nextNonce === null ? pending : Math.max(this.nextNonce, pending);
      this.store.updateTx(txId, { nonce });
      const sentAt = Date.now();
      const hash = await this.client.writeContract({ ...(request as object), nonce, gas } as Parameters<typeof this.client.writeContract>[0]);
      this.nextNonce = nonce + 1;
      this.store.updateTx(txId, { hash, status: "SENT", sent_at: sentAt });
      try {
        const r = await this.c.pub.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 250 });
        const includedAt = Date.now();
        this.sendToInclusion.record(includedAt - sentAt);
        const status = r.status === "success" ? "INCLUDED" : "REVERTED";
        this.store.updateTx(txId, { status, block: Number(r.blockNumber), included_at: includedAt });
        return { txId, status, hash, block: Number(r.blockNumber) };
      } catch {
        this.store.updateTx(txId, { status: "UNKNOWN", error: "receipt timeout" });
        log.error({ txId, hash, kind }, "receipt timeout — marked UNKNOWN, not resubmitting");
        return { txId, status: "UNKNOWN", hash };
      }
    } catch (e) {
      this.nextNonce = null; // resync from chain next time
      this.store.updateTx(txId, { status: "FAILED", error: (e as Error).message.slice(0, 300) });
      return { txId, status: "FAILED", error: "send failed" };
    }
  }

  /** Re-checks SENT/UNKNOWN txs by hash (e.g. after restart or timeout). Never resends. */
  async reconcile() {
    for (const t of this.store.txsByStatus("SENT", "UNKNOWN")) {
      if (!t.hash || t.sender.toLowerCase() !== this.address.toLowerCase()) continue;
      try {
        const r = await this.c.pub.getTransactionReceipt({ hash: t.hash as Hex });
        this.store.updateTx(t.id, { status: r.status === "success" ? "INCLUDED" : "REVERTED", block: Number(r.blockNumber), included_at: Date.now() });
      } catch {
        // still pending or dropped: leave for operator review; the nonce is NOT reused automatically
      }
    }
  }
}
