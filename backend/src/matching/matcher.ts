import type { Hex } from "viem";
import { log } from "../log";
import { Counters, Latency } from "../metrics";
import type { IntentRow, IntentStatus, Store } from "../store/db";
import type { TxResult } from "../chain/executor";

export interface ProofSource { freshProof(maxAgeMs: number, use?: "open" | "settle"): { price: string; tsMs: number; payload: Hex } | null }

/** The executor fetches a fresh opening proof itself when the transaction is actually sent (audit M-05). */
export interface ExecPort {
  openMatched(longRow: IntentRow, shortRow: IntentRow): Promise<TxResult>;
  openHouse(row: IntentRow): Promise<TxResult>;
}

class Rollback extends Error {}

/** Per-wallet pre-checks so one bad request can't fail an innocent counterparty. */
export interface Eligibility { check(row: IntentRow): Promise<string | null> }

export interface MatcherOptions {
  maxQueuePerBucket: number;
  proofMaxAgeMs: number;
  /** Submit matched opens at least this long before either deadline (contract: block.timestamp <= deadline). */
  submitMarginMs: number;
  /** House fallback only once block.timestamp > matchDeadline; wait this long after the deadline. */
  houseAfterDeadlineMs: number;
  positionIdFor(row: IntentRow): Hex;
}

const CAPACITY_ERRORS = new Set(["CapacityUnavailable", "SlotsFull", "ConcentrationLimit"]);
const PRICE_ERRORS = new Set(["PriceLimit", "StalePrice", "PriceFromFuture", "PriceQuality"]);

export function reasonFor(revert: string | null | undefined): { status: IntentStatus; reason: string } {
  if (!revert) return { status: "REJECTED", reason: "Transaction failed. Nothing was opened." };
  if (CAPACITY_ERRORS.has(revert)) return { status: "CAPACITY_UNAVAILABLE", reason: "House capacity unavailable. Nothing was opened." };
  if (PRICE_ERRORS.has(revert)) return { status: "REJECTED", reason: "Price moved beyond your tolerance or the reference was stale. Nothing was opened." };
  if (revert === "MatchWindow") return { status: "EXPIRED", reason: "Match window ended. Nothing was opened." };
  if (revert === "Expired") return { status: "EXPIRED", reason: "Request expired. Nothing was opened." };
  if (revert === "StateForbids") return { status: "REJECTED", reason: "Protocol is not accepting new positions." };
  if (revert === "InsufficientFree") return { status: "REJECTED", reason: "Not enough free balance." };
  if (revert === "NonceUsed") return { status: "CANCELLED", reason: "Request was cancelled or already used." };
  if (revert === "NotAllowlisted") return { status: "REJECTED", reason: "Wallet is not on the commissioning allow-list." };
  if (revert === "ActivePosition") return { status: "REJECTED", reason: "You already have an open position." };
  return { status: "REJECTED", reason: `Rejected by contract (${revert}). Nothing was opened.` };
}

/**
 * Whole-ticket FIFO matcher. Buckets are (collateral, leverage); opposite sides pair in arrival
 * order. No partial fills, no splitting, no self-matching (address-level only — coordinated
 * multi-wallet trading is NOT prevented). Larger size is never prioritised. Persistent: all
 * state transitions go through the store; in-memory buckets are rebuilt from it on start.
 */
export class Matcher {
  readonly matchWait = new Latency();
  readonly admitToOpen = new Latency();
  readonly outcomes = new Counters();
  private busy = new Set<string>();

  constructor(
    private store: Store,
    private prices: ProofSource,
    private exec: ExecPort,
    private elig: Eligibility,
    private notify: (row: IntentRow) => void,
    private opt: MatcherOptions,
    private now: () => number = Date.now,
  ) {}

  bucketKey(r: Pick<IntentRow, "collateral" | "leverage">) { return `${r.collateral}:${r.leverage}`; }

  waiting(collateral: string, leverage: number, side: 0 | 1): number {
    return this.store.intentsByStatus("MATCHING").filter((r) => r.collateral === collateral && r.leverage === leverage && r.side === side && (r.route_mask & 1)).length;
  }

  canAdmit(row: Pick<IntentRow, "collateral" | "leverage">): boolean {
    const n = this.store.intentsByStatus("MATCHING").filter((r) => this.bucketKey(r) === this.bucketKey(row)).length;
    return n < this.opt.maxQueuePerBucket;
  }

  /** Called after a new intent is persisted. */
  async onNew(row: IntentRow) {
    if (row.status === "MATCHING") await this.tryMatch(row);
    else if (row.status === "SUBMITTED" && row.route === "HOUSE") await this.executeHouse(row);
  }

  /** Periodic sweep: retries matching (e.g. after a stale proof), handles deadlines and expiry. */
  async tick() {
    const nowMs = this.now();
    for (const r of this.store.intentsByStatus("MATCHING")) {
      if (this.busy.has(r.id)) continue;
      const deadlineMs = r.match_deadline * 1000;
      if (r.expiry * 1000 <= nowMs) { this.finish(r, "EXPIRED", "Request expired before it could open. Nothing was opened."); continue; }
      if (nowMs <= deadlineMs - this.opt.submitMarginMs) { await this.tryMatch(r); continue; }
      if (nowMs < deadlineMs + this.opt.houseAfterDeadlineMs) continue; // window closing; wait for the house rule
      if (r.route_mask & 2) {
        if (this.store.transition(r.id, ["MATCHING"], "SUBMITTED", { route: "HOUSE" }, "No match in window — house fallback (authorised)")) {
          this.matchWait.record(nowMs - r.created_at);
          this.emit(r.id);
          await this.executeHouse(this.store.getIntent(r.id)!);
        }
      } else {
        this.matchWait.record(nowMs - r.created_at);
        this.finish(r, "EXPIRED", "No compatible match within your window. Nothing was opened.");
      }
    }
  }

  private async tryMatch(row: IntentRow) {
    if (this.busy.has(row.id) || !(row.route_mask & 1)) return;
    const nowMs = this.now();
    if (nowMs > row.match_deadline * 1000 - this.opt.submitMarginMs) return;
    const proof = this.prices.freshProof(this.opt.proofMaxAgeMs, "open");
    if (!proof) return; // retry on next tick
    const px = BigInt(proof.price);
    if (!this.limitOk(row, px)) return;
    const candidates = this.store.intentsByStatus("MATCHING").filter((c) =>
      c.id !== row.id && c.side !== row.side && c.user !== row.user && (c.route_mask & 1) && !this.busy.has(c.id)
      && c.collateral === row.collateral && c.leverage === row.leverage
      && nowMs <= c.match_deadline * 1000 - this.opt.submitMarginMs && this.limitOk(c, px));
    for (const c of candidates) { // FIFO (store returns by created_at)
      const [long, short] = row.side === 0 ? [row, c] : [c, row];
      this.busy.add(long.id); this.busy.add(short.id);
      try {
        const [eL, eS] = await Promise.all([this.elig.check(long), this.elig.check(short)]);
        if (eL) { this.finish(long, "REJECTED", eL); if (long.id === row.id) return; continue; }
        if (eS) { this.finish(short, "REJECTED", eS); if (short.id === row.id) return; continue; }
        // Both legs move together or neither does: a false transition must ROLL BACK the first (audit M-04).
        let ok = false;
        try {
          this.store.db.transaction(() => {
            if (!this.store.transition(long.id, ["MATCHING"], "SUBMITTED", { route: "MATCHED" }, "Matched")) throw new Rollback();
            if (!this.store.transition(short.id, ["MATCHING"], "SUBMITTED", { route: "MATCHED" }, "Matched")) throw new Rollback();
          })();
          ok = true;
        } catch (e) { if (!(e instanceof Rollback)) throw e; }
        if (!ok) continue;
        this.matchWait.record(nowMs - long.created_at);
        this.matchWait.record(nowMs - short.created_at);
        this.emit(long.id); this.emit(short.id);
        const res = await this.exec.openMatched(this.store.getIntent(long.id)!, this.store.getIntent(short.id)!);
        this.afterExec([long.id, short.id], res, "MATCHED");
        return;
      } finally {
        this.busy.delete(long.id); this.busy.delete(short.id);
      }
    }
  }

  private async executeHouse(row: IntentRow) {
    if (this.busy.has(row.id)) return;
    this.busy.add(row.id);
    try {
      const e = await this.elig.check(row);
      if (e) return this.finish(row, "REJECTED", e, ["SUBMITTED"]);
      if (!this.prices.freshProof(this.opt.proofMaxAgeMs, "open")) {
        return this.finish(row, "REJECTED", "No fresh multi-venue price right now. Nothing was opened.", ["SUBMITTED"]);
      }
      const res = await this.exec.openHouse(row);
      this.afterExec([row.id], res, "HOUSE");
    } finally {
      this.busy.delete(row.id);
    }
  }

  private afterExec(ids: string[], res: TxResult, route: "MATCHED" | "HOUSE") {
    for (const id of ids) {
      const row = this.store.getIntent(id)!;
      if (res.status === "INCLUDED") {
        if (this.store.transition(id, ["SUBMITTED"], "OPENED", { tx_id: res.hash ?? null, position_id: this.opt.positionIdFor(row).toLowerCase() }, `Included in block ${res.block}`)) {
          this.outcomes.inc(route === "MATCHED" ? "openedMatched" : "openedHouse");
          this.admitToOpen.record(this.now() - row.created_at);
          this.emit(id);
        }
      } else if (res.status === "UNKNOWN") {
        // Journalled; the executor's reconciler (or the PositionOpened event) settles it either way.
        log.error({ id, hash: res.hash }, "open tx outcome unknown; awaiting reconciliation / events");
      } else if (route === "HOUSE" && res.revert === "MatchWindow") {
        // Chain clock hasn't passed the user's match deadline yet (block timestamps have 1 s
        // granularity). Not a failure: put it back and retry the authorised fallback next tick.
        this.store.transition(id, ["SUBMITTED"], "MATCHING", { route: null }, "Waiting for chain clock to pass the match window");
        this.emit(id);
      } else {
        const { status, reason } = res.status === "REVERTED" ? { status: "REJECTED" as const, reason: "Transaction reverted. Nothing was opened." } : reasonFor(res.revert);
        this.finish(row, status, reason, ["SUBMITTED"]);
      }
    }
  }

  private limitOk(r: IntentRow, px: bigint) {
    const lim = BigInt(r.price_limit);
    return r.side === 0 ? px <= lim : px >= lim;
  }

  finish(r: IntentRow, status: IntentStatus, reason: string, from: IntentStatus[] = ["MATCHING"]) {
    if (this.store.transition(r.id, from, status, { reason })) {
      this.outcomes.inc(status.toLowerCase());
      this.emit(r.id);
    }
  }

  private emit(id: string) {
    const row = this.store.getIntent(id);
    if (row) this.notify(row);
  }
}
