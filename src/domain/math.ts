import type { ProtocolParams } from "@/config/protocol";
import { BPS, floorDiv, max, min, mulBpsCeil, abs } from "./fixed";
import type { CloseReason, Position, Settlement, Side } from "./types";

export const dir = (side: Side) => (side === "LONG" ? 1n : -1n);

export function notionalOf(collateral: bigint, leverage: number): bigint {
  if (!Number.isInteger(leverage) || leverage < 1) throw new RangeError("leverage must be a positive integer");
  return collateral * BigInt(leverage);
}

/**
 * Raw gross P&L at `mark`, before caps and fees. Rounded toward -inf so the trader
 * never receives a fractional unit they are not owed.
 */
export function rawGrossPnl(side: Side, notional: bigint, entry: bigint, mark: bigint): bigint {
  return floorDiv(dir(side) * notional * (mark - entry), entry);
}

/**
 * Price at which equity = maintenanceBps × collateral.
 *   long:  entry × (1 − (1 − mm) / lev)
 *   short: entry × (1 + (1 − mm) / lev)
 * Rounded toward the entry (conservative: triggers no later than the exact price).
 */
export function liquidationPrice(side: Side, entry: bigint, leverage: number, maintenanceBps: number): bigint {
  const move = (entry * (BPS - BigInt(maintenanceBps))) / (BPS * BigInt(leverage)); // floor → closer to entry
  return side === "LONG" ? entry - move : entry + move;
}

export function isLiquidatable(p: Pick<Position, "side" | "liquidationPrice">, mark: bigint): boolean {
  return p.side === "LONG" ? mark <= p.liquidationPrice : mark >= p.liquidationPrice;
}

/** Fee on positive realised gross P&L only. Rounded up (in the protocol's favour). */
export function profitFee(grossPnl: bigint, feeBps: number): bigint {
  return grossPnl > 0n ? mulBpsCeil(grossPnl, feeBps) : 0n;
}

/** Max gross win for a position, given its route. */
export function maxGrossWin(p: Pick<Position, "route" | "houseReservation" | "matchedMaxGrossWin">): bigint {
  return p.route === "HOUSE" ? p.houseReservation : p.matchedMaxGrossWin;
}

/** Gross P&L after caps: loss limited to collateral, win limited by route backing. */
export function cappedGrossPnl(p: Position, mark: bigint): { gross: bigint; capped: boolean } {
  const raw = rawGrossPnl(p.side, p.notional, p.entryPrice, mark);
  if (raw < -p.collateral) return { gross: -p.collateral, capped: true };
  const cap = maxGrossWin(p);
  if (raw > cap) return { gross: cap, capped: true };
  return { gross: raw, capped: false };
}

export function settle(p: Position, exitPrice: bigint, reason: CloseReason, at: number): Settlement {
  // A liquidated position loses its full collateral; the remaining maintenance equity
  // is a liquidation buffer that accrues to the counterparty (house or matched winner).
  const { gross: g, capped } = cappedGrossPnl(p, exitPrice);
  const gross = reason === "LIQUIDATION" ? -p.collateral : g;
  const fee = profitFee(gross, p.feeBps);
  const net = gross - fee;
  return {
    positionId: p.id, route: p.route, side: p.side, collateral: p.collateral, leverage: p.leverage,
    entryPrice: p.entryPrice, exitPrice, grossPnl: gross, fee, netPnl: net,
    returned: p.collateral + net, reason, rightsIssued: 0n, closedAt: at, capped,
  };
}

/**
 * Matched pair settlement at one price. The loser's loss funds the winner's gross win;
 * the fee is taken from the winner's gross. Each side is rounded independently toward
 * -inf, so the loser pays >= what the winner receives; that dust goes to the house.
 *
 * Gap beyond loser collateral is paid only up to the backstop the house reserved at
 * open (v1 default: 0). Anything beyond that is NOT paid — see docs/CONTRACTS.md
 * §Gap policy, which is an open contract decision.
 *
 * `initiatorId` is the position whose holder requested the close (USER reason).
 */
export function settleMatchedPair(
  long: Position, short: Position, exitPrice: bigint, reason: CloseReason, initiatorId: string | null, at: number,
) {
  if (long.side !== "LONG" || short.side !== "SHORT" || long.notional !== short.notional || long.entryPrice !== short.entryPrice) {
    throw new Error("not a compatible matched pair");
  }
  const longRaw = rawGrossPnl("LONG", long.notional, long.entryPrice, exitPrice);
  const shortRaw = rawGrossPnl("SHORT", short.notional, short.entryPrice, exitPrice);
  const longWins = longRaw > 0n;
  const [winner, loser] = longWins ? [long, short] : [short, long];
  const [winnerRaw, loserRaw] = longWins ? [longRaw, shortRaw] : [shortRaw, longRaw];

  const liquidated = reason === "LIQUIDATION";
  const loss = liquidated ? loser.collateral : min(max(0n, -loserRaw), loser.collateral);
  const backstop = max(0n, winner.matchedMaxGrossWin - loser.collateral);
  const base = liquidated ? loss : min(max(0n, winnerRaw), loss);
  const gapPaid = min(max(0n, winnerRaw - loss), backstop);
  const winnerGross = base + gapPaid;
  const fee = profitFee(winnerGross, winner.feeBps);

  const reasonFor = (p: Position, isWinner: boolean): CloseReason => {
    if (reason === "USER") return p.id === initiatorId ? "USER" : "COUNTERPARTY";
    if (reason === "LIQUIDATION") return isWinner ? "COUNTERPARTY_LIQUIDATED" : "LIQUIDATION";
    return reason;
  };
  const mk = (p: Position, gross: bigint, f: bigint, isWinner: boolean): Settlement => ({
    positionId: p.id, route: "MATCHED", side: p.side, collateral: p.collateral, leverage: p.leverage,
    entryPrice: p.entryPrice, exitPrice, grossPnl: gross, fee: f, netPnl: gross - f,
    returned: p.collateral + gross - f, reason: reasonFor(p, isWinner), rightsIssued: 0n, closedAt: at,
    capped: isWinner ? winnerRaw > winnerGross : -loserRaw > loss,
  });
  return {
    winner: mk(winner, winnerGross, fee, true),
    loser: mk(loser, -loss, 0n, false),
    /** Matched fee: house revenue. */
    houseFee: fee,
    /** Paid by the house from the reserved backstop. */
    houseGapPaid: gapPaid,
    /** Rounding dust / unpaid liquidation buffer retained by the house. */
    dust: loss - base,
  };
}

/** Example net profit for a favourable move of `movePct` percent (display only). */
export function exampleNetProfit(collateral: bigint, leverage: number, movePct: number, feeBps: number) {
  const notional = notionalOf(collateral, leverage);
  const gross = (notional * BigInt(Math.round(movePct * 100))) / 10_000n;
  const fee = profitFee(gross, feeBps);
  return { gross, fee, net: gross - fee };
}

/* ------------------------------------------------------------- house capacity */

export interface HouseBook {
  reserve: bigint;
  reservedLiabilities: bigint;
  netDirectionalNotional: bigint; // + = house is net short traders' longs (traders net long)
  openHousePositions: number;
}

export function houseReservationFor(collateral: bigint, params: ProtocolParams): bigint {
  return collateral * BigInt(params.houseReservationMultiple);
}

export function houseAvailableCapacity(book: HouseBook, params: ProtocolParams): bigint {
  const ceiling = (book.reserve * BigInt(params.houseMaxUtilisationBps)) / BPS;
  return max(0n, ceiling - book.reservedLiabilities);
}

export type HouseAdmission = { ok: true; reservation: bigint } | { ok: false; reason: string; reservation: bigint };

export function admitHouseTrade(book: HouseBook, side: Side, collateral: bigint, leverage: number, params: ProtocolParams): HouseAdmission {
  const reservation = houseReservationFor(collateral, params);
  if (book.openHousePositions >= params.maxConcurrentHousePositions) {
    return { ok: false, reason: "House position slots are full", reservation };
  }
  if (reservation > houseAvailableCapacity(book, params)) {
    return { ok: false, reason: "Not enough house reserve capacity", reservation };
  }
  const nextNet = book.netDirectionalNotional + dir(side) * notionalOf(collateral, leverage);
  const limit = book.reserve * BigInt(params.houseMaxNetNotionalMultiple);
  if (abs(nextNet) > limit && abs(nextNet) > abs(book.netDirectionalNotional)) {
    return { ok: false, reason: `House is at its ${side === "LONG" ? "long" : "short"} concentration limit`, reservation };
  }
  return { ok: true, reservation };
}

/**
 * Reserve-protection: when unrealised gross gain reaches protectionTriggerBps of the
 * reservation, the keeper tries to extend the reservation from free capacity. If it
 * cannot, the position is closed early. Returns the extension needed (0 if none).
 */
export function protectionCheck(p: Position, mark: bigint, params: ProtocolParams): { triggered: boolean; extension: bigint } {
  if (p.route !== "HOUSE") return { triggered: false, extension: 0n };
  const raw = rawGrossPnl(p.side, p.notional, p.entryPrice, mark);
  const trigger = (p.houseReservation * BigInt(params.protectionTriggerBps)) / BPS;
  if (raw < trigger) return { triggered: false, extension: 0n };
  return { triggered: true, extension: houseReservationFor(p.collateral, params) };
}

/** Distance from mark to liquidation, bps of mark. */
export function distanceToLiqBps(p: Pick<Position, "side" | "liquidationPrice">, mark: bigint): number {
  const d = p.side === "LONG" ? mark - p.liquidationPrice : p.liquidationPrice - mark;
  return Number((d * BPS) / mark);
}

export function slippageLimit(side: Side, price: bigint, slippageBps: number): bigint {
  const delta = (price * BigInt(slippageBps)) / BPS;
  return side === "LONG" ? price + delta : price - delta;
}
