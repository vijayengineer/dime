import type { ProtocolParams } from "@/config/protocol";
import { BPS, floorDiv, max, min } from "./fixed";

/**
 * Rights ledger, mirroring the IChalkRights contract module (docs/CONTRACTS.md).
 *
 * Issuance: each user has a cumulative net result on HOUSE trades (losses positive,
 * net winning payouts negative). Rights are issued only on the increase of that
 * cumulative net loss above its prior high-water mark, so a user who wins back and
 * loses again does not earn rights twice on the same dollars.
 *
 * Activation: rights issued in epoch E are pending until E+1 begins.
 *
 * Distribution: per-epoch, the keeper funds min(distributionShare × eligible new house
 * earnings, surplus above reserve floor). Eligible earnings only count after the house's
 * cumulative earnings exceed their previous high-water mark (prior losses recovered first).
 * Funded USDC is moved out of the reserve into a claims pool and credited pro-rata to
 * ACTIVE rights via a cumulative index. Matched trades never issue rights in v1.
 *
 * Rights are non-transferable, have no principal claim, and may earn nothing.
 */

export const INDEX_SCALE = 10n ** 18n;
export const DIME_DECIMALS = 18;

/** DIME per $1 of eligible loss (18dp): flat up to decayTvl of house reserve, then × (decayTvl/reserve)³,
 *  rounding down at each step. Mirrors DimeProtocol.emissionRate. */
export function emissionRate(params: Pick<ProtocolParams, "dimePerUsdE18" | "emissionDecayTvl"> & Partial<Pick<ProtocolParams, "emissionCurve">>, reserve: bigint): bigint {
  const d = params.emissionDecayTvl;
  if (reserve <= d || reserve === 0n) return params.dimePerUsdE18;
  if (params.emissionCurve === "inverse") return (params.dimePerUsdE18 * d) / reserve; // older deployments
  let rate = params.dimePerUsdE18;
  for (let i = 0; i < 3; i++) rate = (rate * d) / reserve;
  return rate;
}

export interface UserRights {
  cumulativeNetLoss: bigint;
  netLossHighWater: bigint;
  pending: bigint;
  pendingEpoch: number | null; // epoch in which pending becomes active
  active: bigint;
  indexSnapshot: bigint;
  accrued: bigint;
  claimed: bigint;
}

export interface RightsGlobal {
  epoch: number;
  totalActive: bigint;
  pendingByEpoch: Map<number, bigint>;
  rewardIndex: bigint;
  /** Cumulative house earnings (collected losses + matched fees − net payouts). */
  houseCumulativeEarnings: bigint;
  /** Highest houseCumulativeEarnings already considered for distribution. */
  earningsHighWater: bigint;
  fundedTotal: bigint;
  claimedTotal: bigint;
  mintedInEpoch: Map<number, bigint>;
  /** rewardIndex at the start of each epoch, so lazily-activated rights accrue from their activation epoch. */
  indexAtEpochStart: Map<number, bigint>;
}

export const newUserRights = (): UserRights => ({
  cumulativeNetLoss: 0n, netLossHighWater: 0n, pending: 0n, pendingEpoch: null,
  active: 0n, indexSnapshot: 0n, accrued: 0n, claimed: 0n,
});

export const newRightsGlobal = (): RightsGlobal => ({
  epoch: 1, totalActive: 0n, pendingByEpoch: new Map(), rewardIndex: 0n,
  houseCumulativeEarnings: 0n, earningsHighWater: 0n, fundedTotal: 0n, claimedTotal: 0n, mintedInEpoch: new Map(),
  indexAtEpochStart: new Map([[1, 0n]]),
});

/** Bring a user's accrued rewards up to the current index. Must run before any change to `active`. */
export function accrue(u: UserRights, g: RightsGlobal): void {
  if (u.active > 0n) u.accrued += ((g.rewardIndex - u.indexSnapshot) * u.active) / INDEX_SCALE; // floor; dust stays in pool
  u.indexSnapshot = g.rewardIndex;
}

/** Activate a user's pending rights if their activation epoch has begun. */
export function activateIfDue(u: UserRights, g: RightsGlobal): bigint {
  if (u.pendingEpoch === null || u.pendingEpoch > g.epoch) return 0n;
  accrue(u, g);
  const amt = u.pending;
  const startIndex = g.indexAtEpochStart.get(u.pendingEpoch) ?? g.rewardIndex;
  u.accrued += ((g.rewardIndex - startIndex) * amt) / INDEX_SCALE;
  u.active += amt;
  u.pending = 0n;
  u.pendingEpoch = null;
  return amt;
}

/**
 * Record a settled HOUSE trade's net result and issue DIME (auto-staked, active next epoch) on any
 * new net-loss high, at the TVL-decayed rate and within the per-epoch cap. Returns DIME issued (18dp).
 * `traderNet` is the trader's net P&L (negative = loss). Mirrors DimeRights.recordHouseResult.
 */
export function recordHouseResult(u: UserRights, g: RightsGlobal, traderNet: bigint, params: ProtocolParams, reserve: bigint): bigint {
  activateIfDue(u, g);
  u.cumulativeNetLoss -= traderNet;
  if (u.cumulativeNetLoss <= u.netLossHighWater) return 0n;
  const newLoss = u.cumulativeNetLoss - u.netLossHighWater;
  u.netLossHighWater = u.cumulativeNetLoss;
  let issued = (newLoss * emissionRate(params, reserve)) / 1_000_000n;
  const minted = g.mintedInEpoch.get(g.epoch) ?? 0n;
  const room = params.maxMintPerEpoch > minted ? params.maxMintPerEpoch - minted : 0n;
  if (issued > room) issued = room;
  if (issued === 0n) return 0n;
  g.mintedInEpoch.set(g.epoch, minted + issued);
  addPending(u, g, issued);
  return issued;
}

function addPending(u: UserRights, g: RightsGlobal, amount: bigint) {
  const at = g.epoch + 1;
  u.pending += amount;
  u.pendingEpoch = at;
  g.pendingByEpoch.set(at, (g.pendingByEpoch.get(at) ?? 0n) + amount);
}

/** Stake DIME (already moved from the wallet). Activates next epoch. */
export function stake(u: UserRights, g: RightsGlobal, amount: bigint): void {
  activateIfDue(u, g);
  addPending(u, g, amount);
}

/** Unstake: pending first, then active. Accrued USDC stays claimable. */
export function unstake(u: UserRights, g: RightsGlobal, amount: bigint): void {
  activateIfDue(u, g);
  accrue(u, g);
  if (amount > u.pending + u.active) throw new Error("Not enough staked DIME");
  const fromPending = amount < u.pending ? amount : u.pending;
  if (fromPending > 0n && u.pendingEpoch !== null) {
    u.pending -= fromPending;
    g.pendingByEpoch.set(u.pendingEpoch, (g.pendingByEpoch.get(u.pendingEpoch) ?? 0n) - fromPending);
    if (u.pending === 0n) u.pendingEpoch = null;
  }
  const fromActive = amount - fromPending;
  if (fromActive > 0n) {
    u.active -= fromActive;
    g.totalActive -= fromActive;
  }
}

/** Record house earnings movement (collected loss, matched fee: +; net payout to a winner: −). */
export function recordHouseEarnings(g: RightsGlobal, delta: bigint): void {
  g.houseCumulativeEarnings += delta;
}

export interface FundingResult {
  eligibleNewEarnings: bigint;
  target: bigint;
  funded: bigint;
  limitedBy: "NONE" | "NO_ACTIVE_RIGHTS" | "NO_NEW_EARNINGS" | "RESERVE_FLOOR";
}

/**
 * End-of-epoch funding. `reserve` is house capital after all settled trades;
 * `reservedLiabilities` are current obligations to open positions.
 * Returns the amount to move from reserve into the claims pool.
 */
export function computeFunding(
  g: RightsGlobal, reserve: bigint, reservedLiabilities: bigint, params: ProtocolParams,
): FundingResult {
  const eligible = max(0n, g.houseCumulativeEarnings - g.earningsHighWater);
  const target = (eligible * BigInt(params.distributionShareBps)) / BPS;
  if (eligible === 0n) return { eligibleNewEarnings: 0n, target: 0n, funded: 0n, limitedBy: "NO_NEW_EARNINGS" };
  if (g.totalActive === 0n) return { eligibleNewEarnings: eligible, target, funded: 0n, limitedBy: "NO_ACTIVE_RIGHTS" };
  const surplus = max(0n, reserve - reservedLiabilities - params.distributionReserveFloor);
  const funded = min(target, surplus);
  return { eligibleNewEarnings: eligible, target, funded, limitedBy: funded < target ? "RESERVE_FLOOR" : "NONE" };
}

/** Apply funding: advances the earnings high-water mark and the reward index. */
export function applyFunding(g: RightsGlobal, f: FundingResult): bigint {
  if (f.limitedBy === "NO_NEW_EARNINGS") return 0n;
  // Earnings are consumed for distribution purposes even when nothing could be funded
  // (no active rights, or reserve floor). Retaining them rebuilds the reserve; they are
  // never queued for rights that activate later.
  g.earningsHighWater = g.houseCumulativeEarnings;
  if (f.funded === 0n) return 0n;
  g.rewardIndex += floorDiv(f.funded * INDEX_SCALE, g.totalActive);
  g.fundedTotal += f.funded;
  return f.funded;
}

/**
 * Start the next epoch: pending issuance scheduled for it becomes part of totalActive.
 * The keeper must fund the closing epoch BEFORE advancing, so rights activating now do
 * not share in earnings made before they were active.
 */
export function advanceEpoch(g: RightsGlobal): void {
  g.epoch += 1;
  g.indexAtEpochStart.set(g.epoch, g.rewardIndex);
  const activating = g.pendingByEpoch.get(g.epoch) ?? 0n;
  g.pendingByEpoch.delete(g.epoch);
  g.totalActive += activating;
}

export function claimable(u: UserRights, g: RightsGlobal): bigint {
  let total = u.accrued;
  if (u.active > 0n) total += ((g.rewardIndex - u.indexSnapshot) * u.active) / INDEX_SCALE;
  if (u.pendingEpoch !== null && u.pendingEpoch <= g.epoch) {
    const startIndex = g.indexAtEpochStart.get(u.pendingEpoch) ?? g.rewardIndex;
    total += ((g.rewardIndex - startIndex) * u.pending) / INDEX_SCALE;
  }
  return total;
}

export function claim(u: UserRights, g: RightsGlobal): bigint {
  activateIfDue(u, g);
  accrue(u, g);
  const amt = u.accrued;
  u.accrued = 0n;
  u.claimed += amt;
  g.claimedTotal += amt;
  return amt;
}

export function participationBps(u: UserRights, g: RightsGlobal): number {
  const mine = effectiveActive(u, g);
  return g.totalActive === 0n ? 0 : Number((mine * BPS) / g.totalActive);
}

/** Active amount including pending that has already reached its activation epoch. */
export function effectiveActive(u: UserRights, g: RightsGlobal): bigint {
  return u.active + (u.pendingEpoch !== null && u.pendingEpoch <= g.epoch ? u.pending : 0n);
}
