/**
 * House admission queue. Capacity is exposure-based (each position reserves collateral ×
 * houseReservationMultiple against reserve × utilisation, plus the net-directional limit), so a
 * request can be too big for what is free right now while a smaller one behind it fits.
 *
 * Policy, in arrival order:
 *  - The head opens as soon as it fits.
 *  - While the head doesn't fit, later requests that fit may "backfill" the gap, but only for
 *    `headHoldMs` after the head started waiting. After that, nothing jumps the head: freed
 *    capacity is held for it until it opens or its signed request expires.
 *  - Size never buys priority. A wallet has at most one live request (enforced at admission),
 *    so the queue is already one turn per wallet.
 * Pure: the matcher feeds it a snapshot and submits what it returns.
 */

export interface QueuedReq {
  id: string;
  side: 0 | 1; // 0 = long
  collateral: bigint;
  leverage: number;
  /** When it joined the house queue (ms). */
  queuedAt: number;
}

export interface HouseCapacity {
  /** reserve × utilisation − reserved liabilities − matched backstop, minus in-flight reservations. */
  available: bigint;
  reserve: bigint;
  netDirectional: bigint;
  reservationMultiple: bigint;
  netNotionalMultiple: bigint;
}

export interface QueueOptions { headHoldMs: number }

const abs = (x: bigint) => (x < 0n ? -x : x);

export function reservationFor(r: Pick<QueuedReq, "collateral">, cap: Pick<HouseCapacity, "reservationMultiple">) {
  return r.collateral * cap.reservationMultiple;
}

/** Mirrors DimeProtocol.openHouse's capacity and concentration checks against a running snapshot. */
export function fits(r: QueuedReq, cap: HouseCapacity): boolean {
  if (reservationFor(r, cap) > cap.available) return false;
  const notional = r.collateral * BigInt(r.leverage);
  const next = cap.netDirectional + (r.side === 0 ? notional : -notional);
  const limit = cap.reserve * cap.netNotionalMultiple;
  return !(abs(next) > limit && abs(next) > abs(cap.netDirectional));
}

function take(r: QueuedReq, cap: HouseCapacity): HouseCapacity {
  const notional = r.collateral * BigInt(r.leverage);
  return { ...cap, available: cap.available - reservationFor(r, cap), netDirectional: cap.netDirectional + (r.side === 0 ? notional : -notional) };
}

/** Ids to submit now, in order. `queue` must be in arrival order. */
export function planAdmissions(queue: QueuedReq[], cap: HouseCapacity, now: number, o: QueueOptions): string[] {
  const out: string[] = [];
  let c = cap;
  let i = 0;
  // Everyone at the front who fits, in order.
  while (i < queue.length && fits(queue[i], c)) { c = take(queue[i], c); out.push(queue[i].id); i++; }
  if (i >= queue.length) return out;
  // The head is blocked. Backfill only during its hold window.
  const head = queue[i];
  if (now - head.queuedAt >= o.headHoldMs) return out;
  for (let j = i + 1; j < queue.length; j++) {
    if (fits(queue[j], c)) { c = take(queue[j], c); out.push(queue[j].id); }
  }
  return out;
}

export interface QueueSpot {
  /** 1-based place in line among waiting requests. */
  position: number;
  /** True while a smaller request may still open ahead of a blocked head (gap filling). */
  canFillGap: boolean;
}

export function queueSpot(queue: QueuedReq[], id: string, cap: HouseCapacity | null, now: number, o: QueueOptions): QueueSpot | null {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx < 0) return null;
  const head = queue[0];
  const canFillGap = idx > 0 && cap !== null && !fits(head, cap) && now - head.queuedAt < o.headHoldMs;
  return { position: idx + 1, canFillGap };
}
