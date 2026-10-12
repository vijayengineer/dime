import { EventEmitter } from "node:events";
import { parseEventLogs, type Hex, type Log } from "viem";
import { dimeAbi, dimeRightsAbi } from "../../../shared/abi";
import { log } from "../log";
import type { Store } from "../store/db";
import type { Chain } from "./chain";

const ABI = [...dimeAbi, ...dimeRightsAbi.filter((x) => x.type === "event")] as const;
const REASONS = ["USER", "COUNTERPARTY", "LIQUIDATION", "COUNTERPARTY_LIQUIDATED", "RESERVE_PROTECTION", "EMERGENCY"] as const;

export interface SettlementWire {
  positionId: string; route: "MATCHED" | "HOUSE"; side: "LONG" | "SHORT"; collateral: string; leverage: number;
  entryPrice: string; exitPrice: string; grossPnl: string; fee: string; netPnl: string; returned: string;
  reason: (typeof REASONS)[number]; rightsIssued: string; closedAt: number; closeTx: string; capped: boolean; user: string;
}

/**
 * Polls protocol logs from a persisted cursor (restart-safe), maintains the positions index,
 * and emits "opened" / "settled" / "event". This is a convenience mirror — the contract is
 * authoritative and Envio is the durable history for the frontend.
 */
export class EventWatcher extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  lastBlock = 0n;
  headBlock = 0n;

  constructor(private c: Chain, private store: Store, private fromBlock: number, private cursorKey = "cursor", private chunk = 100n, private everyMs = 500) { super(); }

  start() { void this.loop(); }
  stop() { if (this.timer) clearTimeout(this.timer); }

  private async loop() {
    try { await this.poll(); } catch (e) { log.warn({ err: (e as Error).message }, "event poll failed"); }
    this.timer = setTimeout(() => void this.loop(), this.everyMs);
  }

  async poll() {
    const head = await this.c.pub.getBlockNumber();
    this.headBlock = head;
    let from = BigInt(this.store.getMeta(this.cursorKey) ?? String(this.fromBlock));
    while (from <= head) {
      const to = from + this.chunk - 1n < head ? from + this.chunk - 1n : head;
      const logs = await this.c.pub.getLogs({ address: this.c.protocol.address, fromBlock: from, toBlock: to });
      if (logs.length) await this.handle(logs);
      this.store.setMeta(this.cursorKey, String(to + 1n));
      this.lastBlock = to;
      from = to + 1n;
    }
  }

  private async handle(raw: Log[]) {
    const events = parseEventLogs({ abi: ABI, logs: raw });
    const rightsByTx = new Map<string, bigint>();
    for (const e of events) if (e.eventName === "DimeIssued") rightsByTx.set(`${e.transactionHash}:${(e.args as { user: string }).user.toLowerCase()}`, (e.args as { amount: bigint }).amount);
    const blockTimes = new Map<bigint, number>();
    const tsOf = async (b: bigint) => {
      if (!blockTimes.has(b)) blockTimes.set(b, Number((await this.c.pub.getBlock({ blockNumber: b })).timestamp) * 1000);
      return blockTimes.get(b)!;
    };
    for (const e of events) {
      const a = e.args as Record<string, unknown>;
      if (e.eventName === "PositionOpened") {
        const id = String(a.id).toLowerCase();
        this.store.upsertPosition({
          id, user: String(a.user).toLowerCase(), route: Number(a.route) === 0 ? "MATCHED" : "HOUSE", side: Number(a.side) as 0 | 1,
          collateral: String(a.collateral), leverage: Number(a.leverage), entry: String(a.entryPrice), liq: String(a.liquidationPrice),
          reservation: String(a.houseReservation), pair_id: Number(a.route) === 0 ? String(a.pairId) : null,
          opened_block: Number(e.blockNumber), open_tx: e.transactionHash,
        });
        this.emit("opened", { id, user: String(a.user).toLowerCase(), txHash: e.transactionHash, block: e.blockNumber });
      } else if (e.eventName === "HouseReservationChanged") {
        this.store.setReservation(String(a.id), String(a.newReservation));
      } else if (e.eventName === "PositionSettled") {
        const id = String(a.id).toLowerCase();
        const p = this.store.getPosition(id);
        this.store.markSettled(id);
        const user = String(a.user).toLowerCase();
        const gross = a.grossPnl as bigint;
        const s: SettlementWire = {
          positionId: id, user, route: Number(a.route) === 0 ? "MATCHED" : "HOUSE", side: p?.side === 1 ? "SHORT" : "LONG",
          collateral: p?.collateral ?? "0", leverage: p?.leverage ?? 0, entryPrice: p?.entry ?? "0", exitPrice: String(a.exitPrice),
          grossPnl: gross.toString(), fee: String(a.fee), netPnl: String(a.netPnl), returned: String(a.returned),
          reason: REASONS[Number(a.reason)], rightsIssued: String(rightsByTx.get(`${e.transactionHash}:${user}`) ?? 0n),
          closedAt: await tsOf(e.blockNumber), closeTx: e.transactionHash, capped: false, // cap flag not in event; UI derives from P&L vs collateral
        };
        this.emit("settled", s);
      }
      this.emit("event", { name: e.eventName, args: a, txHash: e.transactionHash as Hex, block: e.blockNumber });
    }
  }
}
