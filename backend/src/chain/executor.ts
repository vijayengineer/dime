import { randomUUID } from "node:crypto";
import { encodeFunctionData, keccak256, type Abi, type Hex } from "viem";
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

/** 0 = risk-reducing (closes, liquidations, protection, heartbeats, state changes) · 1 = everything else. */
export type Priority = 0 | 1;

/**
 * Arguments are built when the job reaches the front of the queue, so price proofs are fresh at send
 * time (audit M-05). Return null to fail the job without sending (e.g. no eligible price).
 */
export type ArgsBuilder = () => Promise<readonly unknown[] | null> | readonly unknown[] | null;

export interface SubmitOptions {
  priority?: Priority;
  /** Give up (FAILED, nothing sent) if the job hasn't started within this long. */
  deadlineMs?: number;
}

interface Job {
  kind: TxRow["kind"]; ref: string; functionName: string; build: ArgsBuilder; priority: Priority; enqueuedAt: number; deadlineMs: number;
  resolve: (r: TxResult) => void;
}

/** RPC errors that prove the transaction was NOT accepted. Anything else after a send is ambiguous. */
const DEFINITE_REJECTION = /nonce too low|insufficient funds|intrinsic gas|exceeds block gas limit|replacement transaction underpriced|invalid sender|gas limit reached/i;

/**
 * One signer, one in-flight transaction at a time; a priority queue so risk-reducing work never waits
 * behind opens. Every transaction is SIGNED and JOURNALLED (raw bytes, nonce, hash) BEFORE broadcast;
 * an ambiguous send is UNKNOWN, never FAILED, and the reconciler resolves it from receipts and the
 * sender nonce, re-broadcasting the identical signed bytes when needed (same hash, so never a duplicate)
 * (audit M-03). Simulation runs first to fail fast with the contract's custom error.
 */
export class Executor {
  private queue: Job[] = [];
  private running = false;
  private nextNonce: number | null = null;
  readonly sendToInclusion = new Latency();
  readonly address: Hex;
  private client;
  private resolvedListeners: ((t: TxRow) => void)[] = [];

  constructor(private store: Store, private c: Chain, key: Hex, readonly role: string, private maxDepth = 200) {
    const w = c.wallet(key);
    this.client = w.client;
    this.address = w.account.address;
  }

  get queueDepth() { return this.queue.length + (this.running ? 1 : 0); }
  get oldestQueuedMs() { return this.queue.length ? Date.now() - Math.min(...this.queue.map((j) => j.enqueuedAt)) : 0; }

  /** Called whenever a journalled transaction reaches a final state (including after a restart). */
  onResolved(fn: (t: TxRow) => void) { this.resolvedListeners.push(fn); }

  submit(kind: TxRow["kind"], ref: string, functionName: string, build: ArgsBuilder | readonly unknown[], opt: SubmitOptions = {}): Promise<TxResult> {
    if (this.queue.length >= this.maxDepth) return Promise.resolve({ txId: "", status: "FAILED", error: "executor queue full" });
    const builder: ArgsBuilder = typeof build === "function" ? build : () => build;
    return new Promise((resolve) => {
      this.queue.push({ kind, ref, functionName, build: builder, priority: opt.priority ?? 1, enqueuedAt: Date.now(), deadlineMs: opt.deadlineMs ?? 30_000, resolve });
      void this.pump();
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        // highest priority first, FIFO within a priority
        let i = 0;
        for (let k = 1; k < this.queue.length; k++) if (this.queue[k].priority < this.queue[i].priority) i = k;
        const job = this.queue.splice(i, 1)[0];
        if (Date.now() - job.enqueuedAt > job.deadlineMs) {
          job.resolve({ txId: "", status: "FAILED", error: "queue deadline passed; nothing was sent" });
          continue;
        }
        job.resolve(await this.run(job).catch((e) => ({ txId: "", status: "FAILED" as const, error: (e as Error).message.slice(0, 200) })));
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: Job): Promise<TxResult> {
    const txId = randomUUID();
    const now = Date.now();
    this.store.insertTx({
      id: txId, kind: job.kind, ref: job.ref, sender: this.address, nonce: null, hash: null, raw: null, status: "PREPARED", error: null,
      block: null, sent_at: null, included_at: null, created_at: now, updated_at: now,
    });
    const args = await job.build();
    if (!args) {
      this.store.updateTx(txId, { status: "FAILED", error: "no eligible price at send time" });
      return { txId, status: "FAILED", error: "no eligible price at send time" };
    }
    const call = { ...this.c.protocol, abi: this.c.protocol.abi as Abi, functionName: job.functionName, args: args as unknown[], account: this.client.account };
    try {
      await this.c.pub.simulateContract(call);
    } catch (e) {
      const revert = revertName(e);
      this.store.updateTx(txId, { status: "FAILED", error: revert ?? (e as Error).message.slice(0, 300) });
      return { txId, status: "FAILED", revert, error: revert ?? "simulation failed" };
    }
    let nonce: number, hash: Hex, raw: Hex;
    try {
      // Estimates can be tight when settlement takes a different branch at inclusion time; add 30%.
      const est = await this.c.pub.estimateContractGas(call);
      const pending = await this.c.pub.getTransactionCount({ address: this.address, blockTag: "pending" });
      nonce = this.nextNonce === null ? pending : Math.max(this.nextNonce, pending);
      // Explicit target and calldata: a simulation "request" is not a transaction and carries no encoded data.
      const data = encodeFunctionData({ abi: this.c.protocol.abi as Abi, functionName: job.functionName, args: args as unknown[] });
      const prepared = await this.client.prepareTransactionRequest({
        account: this.client.account, chain: this.c.chain, to: this.c.protocol.address, data, nonce, gas: (est * 13n) / 10n,
      } as never);
      raw = await this.client.signTransaction(prepared as never);
      hash = keccak256(raw);
    } catch (e) {
      this.nextNonce = null;
      this.store.updateTx(txId, { status: "FAILED", error: (e as Error).message.slice(0, 300) });
      return { txId, status: "FAILED", error: "could not prepare transaction" };
    }
    // Journal BEFORE broadcast: if the response is lost we still know the hash, nonce and exact bytes.
    this.store.updateTx(txId, { nonce, hash, raw, status: "SIGNED" });
    const sentAt = Date.now();
    try {
      await this.c.pub.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      const msg = (e as Error).message;
      if (DEFINITE_REJECTION.test(msg)) {
        this.nextNonce = null;
        this.store.updateTx(txId, { status: "FAILED", error: msg.slice(0, 300) });
        this.resolved(txId);
        return { txId, status: "FAILED", error: "send rejected" };
      }
      // Ambiguous: the node may have accepted it. Keep the nonce reserved; the reconciler decides.
      this.nextNonce = nonce + 1;
      this.store.updateTx(txId, { status: "UNKNOWN", error: `send outcome unknown: ${msg.slice(0, 200)}`, sent_at: sentAt });
      log.error({ txId, hash, kind: job.kind }, "send outcome unknown — journalled, reconciling");
      return { txId, status: "UNKNOWN", hash };
    }
    this.nextNonce = nonce + 1;
    this.store.updateTx(txId, { status: "SENT", sent_at: sentAt });
    try {
      const r = await this.c.pub.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 250 });
      const includedAt = Date.now();
      this.sendToInclusion.record(includedAt - sentAt);
      const status = r.status === "success" ? "INCLUDED" : "REVERTED";
      this.store.updateTx(txId, { status, block: Number(r.blockNumber), included_at: includedAt });
      this.resolved(txId);
      return { txId, status, hash, block: Number(r.blockNumber) };
    } catch {
      this.store.updateTx(txId, { status: "UNKNOWN", error: "receipt timeout" });
      log.error({ txId, hash, kind: job.kind }, "receipt timeout — marked UNKNOWN, reconciling");
      return { txId, status: "UNKNOWN", hash };
    }
  }

  private resolved(txId: string) {
    const t = this.store.getTx(txId);
    if (t) for (const fn of this.resolvedListeners) { try { fn(t); } catch (e) { log.error({ err: (e as Error).message }, "tx listener failed"); } }
  }

  /**
   * Resolves SIGNED / SENT / UNKNOWN transactions: a receipt settles them; if the sender's nonce has moved
   * past them without a receipt they were dropped or replaced; otherwise the identical signed bytes are
   * re-broadcast (safe: same hash). Runs on start and periodically.
   */
  async reconcile(rebroadcastAfterMs = 15_000) {
    const open = this.store.txsByStatus("SIGNED", "SENT", "UNKNOWN").filter((t) => t.sender.toLowerCase() === this.address.toLowerCase());
    if (!open.length) return;
    let mined: number | null = null;
    for (const t of open) {
      if (!t.hash) { this.store.updateTx(t.id, { status: "FAILED", error: "never signed" }); this.resolved(t.id); continue; }
      try {
        const r = await this.c.pub.getTransactionReceipt({ hash: t.hash as Hex });
        this.store.updateTx(t.id, { status: r.status === "success" ? "INCLUDED" : "REVERTED", block: Number(r.blockNumber), included_at: Date.now() });
        this.resolved(t.id);
        continue;
      } catch { /* no receipt yet */ }
      try {
        mined ??= await this.c.pub.getTransactionCount({ address: this.address, blockTag: "latest" });
        if (t.nonce !== null && mined > t.nonce) {
          // Nonce consumed but not by this hash (we checked): dropped or replaced. Re-check once more first.
          const again = await this.c.pub.getTransactionReceipt({ hash: t.hash as Hex }).catch(() => null);
          if (again) {
            this.store.updateTx(t.id, { status: again.status === "success" ? "INCLUDED" : "REVERTED", block: Number(again.blockNumber), included_at: Date.now() });
          } else {
            this.store.updateTx(t.id, { status: "DROPPED", error: "nonce used by another transaction" });
            this.nextNonce = null;
          }
          this.resolved(t.id);
          continue;
        }
        if (t.raw && Date.now() - (t.sent_at ?? t.created_at) > rebroadcastAfterMs) {
          await this.c.pub.sendRawTransaction({ serializedTransaction: t.raw as Hex }).catch((e: Error) => {
            if (!/already known|nonce too low/i.test(e.message)) log.warn({ txId: t.id, err: e.message.slice(0, 120) }, "rebroadcast failed");
          });
          this.store.updateTx(t.id, { status: "SENT", sent_at: Date.now() });
        }
      } catch (e) {
        log.warn({ txId: t.id, err: (e as Error).message.slice(0, 120) }, "reconcile check failed");
      }
    }
  }
}
