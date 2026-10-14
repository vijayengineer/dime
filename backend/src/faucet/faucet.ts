import type { Address, Hex } from "viem";
import type { Chain } from "../chain/chain";
import { log } from "../log";
import type { Store } from "../store/db";

/**
 * One-time MON top-up for wallets joining the live test, so email (embedded) wallets can pay gas
 * for approve / deposit / withdraw. Trades themselves are relayed and need no user gas.
 *
 * Grants live in their own ledger keyed by wallet (audit M-08), independent of invites, so the
 * once-per-wallet rule holds in open mode too: PENDING (reserved before sending) → SENT (hash recorded)
 * → CONFIRMED. A global daily budget bounds many-wallet farming. Sends are serialised so the faucet key
 * never races its own nonce.
 */
export class GasFaucet {
  private w;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private c: Chain, key: Hex, private store: Store, private drip: bigint, private minBalance: bigint,
    private dailyBudget: bigint,
  ) {
    this.w = c.wallet(key);
  }

  get address(): Address { return this.w.account.address; }

  /** Queues a top-up; resolves to the tx hash, or null when none was needed or possible. */
  topUp(address: Address): Promise<string | null> {
    const run = async () => {
      const bal = await this.c.pub.getBalance({ address });
      if (bal >= this.minBalance) return null;
      if (this.store.gasGrantedSince(Date.now() - 86_400_000) + this.drip > this.dailyBudget) {
        log.warn({ budget: this.dailyBudget.toString() }, "gas faucet daily budget reached");
        return null;
      }
      const own = await this.c.pub.getBalance({ address: this.address });
      if (own < this.drip * 2n) { log.warn({ faucet: this.address, balance: own.toString() }, "gas faucet low: top it up"); return null; }
      if (!this.store.reserveGasGrant(address, this.drip)) return null; // once per wallet, whatever the mode
      let hash: string;
      try {
        hash = await this.w.client.sendTransaction({ to: address, value: this.drip, chain: this.c.chain, account: this.w.account });
      } catch (e) {
        // Not provably unsent (the node may have accepted it): keep the grant reserved; operator reviews.
        this.store.updateGasGrant(address, { status: "FAILED", error: (e as Error).message.slice(0, 200) });
        throw e;
      }
      this.store.updateGasGrant(address, { status: "SENT", tx: hash });
      const r = await this.c.pub.waitForTransactionReceipt({ hash: hash as Hex });
      this.store.updateGasGrant(address, { status: r.status === "success" ? "CONFIRMED" : "FAILED", error: r.status === "success" ? null : "reverted" });
      log.info({ to: address, hash, wei: this.drip.toString() }, "gas top-up sent");
      return hash;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch((e) => log.error({ err: (e as Error).message.split("\n")[0] }, "gas top-up failed"));
    return p;
  }

  /** Confirms SENT grants whose receipt wasn't seen (e.g. after a restart). */
  async reconcile() {
    for (const g of this.store.gasGrantsByStatus("SENT")) {
      if (!g.tx) continue;
      const r = await this.c.pub.getTransactionReceipt({ hash: g.tx as Hex }).catch(() => null);
      if (r) this.store.updateGasGrant(g.address, { status: r.status === "success" ? "CONFIRMED" : "FAILED" });
    }
  }
}
