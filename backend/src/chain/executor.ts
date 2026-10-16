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

/** Risk-reducing actions go first: a close or liquidation never waits behind someone's open. */
const PRIORITY: ReadonlySet<TxRow["kind"]> = new Set(["CLOSE", "LIQUIDATE", "PROTECT", "SET_STATE"]);
/** Extra queue room kept for priority work, so a flood of opens can't lock closes out. */
const PRIORITY_RESERVE = 50;

/** Args, or a function that builds them when the tx is actually sent (e.g. to attach a fresh price proof). */
export type TxArgs = readonly unknown[] | (() => readonly unknown[]);

interface Job { kind: TxRow["kind"]; ref: string; functionName: string; args: TxArgs; resolve: (r: TxResult) => void }

/**
 * One signer, one in-flight transaction at a time (bounded queue, two lanes). Closes, liquidations,
 * protection closes and state changes jump ahead of opens and epoch funding; within a lane it is
 * first-in, first-out, and size never matters. Every tx is recorded BEFORE it is sent. A timeout
 * marks it UNKNOWN for the reconciler — it is never blindly resubmitted (that could duplicate a
 * position). Simulation runs first to fail fast with the contract's custom error.
 */
export class Executor {
  private high: Job[] = [];
  private normal: Job[] = [];
  private running = false;
  private nextNonce: number | null = null;
  readonly sendToInclusion = new Latency();
  readonly address: Hex;
  private client;

  constructor(private store: Store, private c: Chain, key: Hex, readonly role: string, private maxDepth = 200) {
    const w = c.wallet(key);
    this.client = w.client;
    this.address = w.account.address;
  }

  get queueDepth() { return this.high.length + this.normal.length + (this.running ? 1 : 0); }

  submit(kind: TxRow["kind"], ref: string, functionName: string, args: TxArgs): Promise<TxResult> {
    const prio = PRIORITY.has(kind);
    if (this.queueDepth >= this.maxDepth + (prio ? PRIORITY_RESERVE : 0)) {
      return Promise.resolve({ txId: "", status: "FAILED", error: "executor queue full" });
    }
    return new Promise<TxResult>((resolve) => {
      (prio ? this.high : this.normal).push({ kind, ref, functionName, args, resolve });
      void this.pump();
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.high.shift() ?? this.normal.shift(); job; job = this.high.shift() ?? this.normal.shift()) {
        let res: TxResult;
        try {
          const args = typeof job.args === "function" ? job.args() : job.args;
          res = await this.run(job.kind, job.ref, job.functionName, args);
        } catch (e) {
          res = { txId: "", status: "FAILED", error: (e as Error).message.slice(0, 300) };
        }
        job.resolve(res);
      }
    } finally {
      this.running = false;
    }
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
