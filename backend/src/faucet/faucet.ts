import type { Address, Hex } from "viem";
import type { Chain } from "../chain/chain";
import { log } from "../log";
import type { Store } from "../store/db";

/**
 * One-time MON top-up for wallets joining the live test, so email (embedded) wallets can pay gas
 * for approve / deposit / withdraw. Trades themselves are relayed and need no user gas.
 * Sends are serialised so the faucet key never races its own nonce.
 */
export class GasFaucet {
  private w;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private c: Chain, key: Hex, private store: Store, private drip: bigint, private minBalance: bigint) {
    this.w = c.wallet(key);
  }

  get address(): Address { return this.w.account.address; }

  /** Queues a top-up; resolves to the tx hash, or null when none was needed or possible. */
  topUp(address: Address): Promise<string | null> {
    const run = async () => {
      if (this.store.dripTx(address)) return null; // once per wallet
      const bal = await this.c.pub.getBalance({ address });
      if (bal >= this.minBalance) return null;
      const own = await this.c.pub.getBalance({ address: this.address });
      if (own < this.drip * 2n) { log.warn({ faucet: this.address, balance: own.toString() }, "gas faucet low: top it up"); return null; }
      const hash = await this.w.client.sendTransaction({ to: address, value: this.drip, chain: this.c.chain, account: this.w.account });
      this.store.setDripTx(address, hash);
      await this.c.pub.waitForTransactionReceipt({ hash });
      log.info({ to: address, hash, wei: this.drip.toString() }, "gas top-up sent");
      return hash;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch((e) => log.error({ err: (e as Error).message.split("\n")[0] }, "gas top-up failed"));
    return p;
  }
}
