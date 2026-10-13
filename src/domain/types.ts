import type { Market } from "@/config/protocol";

export type Side = "LONG" | "SHORT";
export type Route = "MATCHED" | "HOUSE";
export type Address = `0x${string}`;
export type Hash = `0x${string}`;

/**
 * Where a displayed value comes from. The UI must label these differently.
 *  ESTIMATE  — model/indicative values (fair-value estimate, unrealised P&L, quotes)
 *  CONFIRMED — read from contract state at a known block
 *  INDEXED   — from Envio (durable history; may lag the chain)
 */
export type Provenance = "ESTIMATE" | "CONFIRMED" | "INDEXED";

export type ProtocolState = "OPEN" | "CLOSE_ONLY" | "ORACLE_HOLD" | "WIND_DOWN" | "INSOLVENT";

export interface Account {
  address: Address;
  /** Privy user id or "demo". Never a credential. */
  userId: string;
  label: string;
}

export interface Balances {
  /** Free customer funds held by the vault (withdrawable). */
  free: bigint;
  /** Collateral locked in the open position. */
  positionCollateral: bigint;
  /** Collateral locked by a pending intent, if the contract escrows at sign time. */
  pendingCollateral: bigint;
  /** USDC in the user's wallet (not deposited). */
  wallet: bigint;
  /** Cumulative external deposits counted against the funding cap. */
  depositedTotal: bigint;
  fundingCap: bigint;
  /** False when an on-chain allow-list is on and this wallet is not on it (live mode only). */
  allowlisted?: boolean;
  provenance: Provenance;
  block?: bigint;
}

/* ------------------------------------------------------------------ pricing */

export interface SourceHealth {
  connectionsUp: number;
  connections: number;
  /** Share of time with a fresh tick (≤1 s), measured since the first tick. */
  uptimePct: number;
  /** Inter-tick intervals > 1 s (quiet market OR outage; see connections for which). */
  gaps: number;
  maxGapMs: number;
  reconnects: number;
  /** Updates absorbed from the redundant connection. */
  duplicates: number;
  latencyP50: number | null;
  latencyP99: number | null;
}

export interface PriceSource {
  id: string;
  name: string;
  /** Basis-adjusted price used by the index (8dp). */
  price: bigint;
  /** Source timestamp, ms since epoch. */
  ts: number;
  seq: number;
  quote?: "USD" | "USDT" | "USDC_PERP";
  /** Share of the liquidity-weighted median, 0..1 (0 = excluded). */
  weight?: number;
  depthUsd?: number;
  ageMs?: number;
  used?: boolean;
  health?: SourceHealth | null;
}

/** DEGRADED = too few fresh venues; price is Hyperliquid alone (still usable, clearly flagged). */
export type PriceQuality = "OK" | "DEGRADED" | "STALE" | "CONFLICT" | "INSUFFICIENT";
export const priceUsable = (q: PriceQuality | undefined) => q === "OK" || q === "DEGRADED";

export interface PriceSnapshot {
  market: Market;
  /** Model fair-value estimate. An estimate, not proof of a fair price. */
  estimate: bigint;
  /** Contract-verifiable reference used for settlement, with its own timestamp. */
  reference: { price: bigint; ts: number; verifier: string } | null;
  sources: PriceSource[];
  /** Age of the freshest acceptable source, ms. */
  ageMs: number;
  /** Max pairwise disagreement between sources, bps. */
  disagreementBps: number;
  /** Estimate vs reference, bps. */
  referenceDeviationBps: number | null;
  quality: PriceQuality;
  receivedAt: number;
  /** True when prices come from real market feeds (even in demo mode, where trading is simulated). */
  liveMarketData?: boolean;
  method?: string;
  plainMedian?: bigint;
  divergenceBps?: number;
  crossChecks?: { hyperliquidOracle?: { price: bigint; ts: number; deviationBps: number } };
  availability?: { uptimePct: number; gaps: number; maxGapMs: number; sinceMs: number };
}

export interface PricePoint { t: number; price: bigint }

/* ------------------------------------------------------------------ intents */

export interface RoutePermission {
  matched: boolean;
  /** User authorised falling back to the house if no match within the window. */
  houseFallback: boolean;
}

export interface OrderDraft {
  side: Side;
  collateral: bigint;
  leverage: number;
  routes: RoutePermission;
  matchWindowMs: number;
  slippageBps: number;
}

export interface CapacityView {
  houseAvailable: boolean;
  houseReason?: string;
  /** Reservation the house would need for this trade. */
  houseReservationRequired: bigint;
  houseCapacityRemaining: bigint;
  housePositionsRemaining: number;
  matchedPairsRemaining: number;
  /** Indicative only: compatible opposite requests currently waiting. */
  matchedOppositeWaiting: number | null;
  provenance: Provenance;
}

export interface Quote {
  id: string;
  draft: OrderDraft;
  indicativeEntry: bigint;
  priceLimit: bigint;
  notional: bigint;
  liquidationPrice: bigint;
  feeBps: number;
  /** Example: net profit if price moves +1% in the user's favour. */
  exampleMovePct: number;
  exampleNetProfit: bigint;
  exampleFee: bigint;
  capacity: CapacityView;
  configVersion: number;
  createdAt: number;
  expiresAt: number;
  latencyMs: number;
  /** Plain-language description of the auto-selected execution (route, window, tolerance). */
  executionSummary?: string;
}

/** EIP-712 message signed by the user. See docs/CONTRACTS.md. */
export interface OrderIntentMessage {
  user: Address;
  market: `0x${string}`; // bytes32 market id
  side: 0 | 1; // 0 = LONG, 1 = SHORT
  collateral: bigint;
  leverage: number;
  /** bit 0 = matched allowed, bit 1 = house allowed */
  routeMask: number;
  matchDeadline: bigint; // unix seconds
  priceLimit: bigint;
  configVersion: number;
  expiry: bigint; // unix seconds
  nonce: bigint;
}

export type IntentStatus =
  | "SIGNING"
  | "MATCHING"
  | "SUBMITTED"
  | "OPENED"
  | "CAPACITY_UNAVAILABLE"
  | "EXPIRED"
  | "REJECTED"
  | "CANCELLED";

export const TERMINAL_INTENT: ReadonlySet<IntentStatus> = new Set([
  "OPENED", "CAPACITY_UNAVAILABLE", "EXPIRED", "REJECTED", "CANCELLED",
]);

export interface IntentState {
  id: string;
  draft: OrderDraft;
  status: IntentStatus;
  route?: Route;
  reason?: string;
  matchDeadline: number;
  expiresAt: number;
  txHash?: Hash;
  positionId?: string;
  updatedAt: number;
  timeline: { status: IntentStatus; at: number; note?: string }[];
}

/* ---------------------------------------------------------------- positions */

export type CloseReason =
  | "USER"
  | "COUNTERPARTY"
  | "LIQUIDATION"
  | "COUNTERPARTY_LIQUIDATED"
  | "RESERVE_PROTECTION"
  | "EMERGENCY";

export interface Position {
  id: string;
  route: Route;
  side: Side;
  collateral: bigint;
  leverage: number;
  notional: bigint;
  entryPrice: bigint;
  liquidationPrice: bigint;
  /** House route: liability the house reserved for this position. */
  houseReservation: bigint;
  /** Matched route: opposing collateral + reserved gap backstop = max gross win. */
  matchedMaxGrossWin: bigint;
  feeBps: number;
  configVersion: number;
  openedAt: number;
  openTx?: Hash;
  counterpartyLabel?: string;
  provenance: Provenance;
}

export interface Settlement {
  positionId: string;
  route: Route;
  side: Side;
  collateral: bigint;
  leverage: number;
  entryPrice: bigint;
  exitPrice: bigint;
  /** Gross P&L before fee, after caps. Negative = loss. */
  grossPnl: bigint;
  fee: bigint;
  /** grossPnl - fee for winners; grossPnl for losers. */
  netPnl: bigint;
  /** Collateral + netPnl returned to free balance. */
  returned: bigint;
  reason: CloseReason;
  rightsIssued: bigint;
  closedAt: number;
  closeTx?: Hash;
  capped: boolean;
}

export interface PositionView {
  position: Position;
  mark: bigint;
  /** All ESTIMATE: indicative until settlement is confirmed. */
  grossPnl: bigint;
  estFee: bigint;
  netPnl: bigint;
  equity: bigint;
  distanceToLiqBps: number;
  closing: boolean;
}

/* -------------------------------------------------------------------- house */

export interface HouseSnapshot {
  /** House capital: founder reserve + retained earnings. Excludes customer funds. */
  reserve: bigint;
  /** Sum of reservations held against open house positions. */
  reservedLiabilities: bigint;
  /** Current mark-to-market amount the house would owe winners right now (ESTIMATE). */
  unrealisedOwed: bigint;
  /** reserve * utilisation - reservedLiabilities, floored at 0. */
  availableCapacity: bigint;
  /** Matched collateral locked in pairs. Not house capital. */
  matchedCollateralLocked: bigint;
  matchedBackstopReserved: bigint;
  /** Funded distributions not yet claimed. Held separately from reserve. */
  fundedUnclaimed: bigint;
  /** Liabilities the house could not cover, if any. Should be 0. */
  unfundedLiabilities: bigint;
  collectedLosses: bigint;
  netWinningPayouts: bigint;
  matchedFees: bigint;
  distributionsFunded: bigint;
  distributionsClaimed: bigint;
  netDirectionalNotional: bigint;
  houseLongNotional: bigint;
  houseShortNotional: bigint;
  matchedNotionalPerSide: bigint;
  openHousePositions: number;
  openMatchedPairs: number;
  state: ProtocolState;
  epoch: number;
  epochEndsAt: number;
  provenance: Provenance;
  block?: bigint;
}

/** One sample of house state for charts (client-side history, sampled from snapshots). */
export interface HousePoint { t: number; reserve: bigint; available: bigint; pnl: bigint }

export interface RightsSnapshot {
  pending: bigint;
  pendingActivatesEpoch: number | null;
  active: bigint;
  totalActive: bigint;
  /** Pending issuance across all users activating next epoch. */
  totalPendingNextEpoch: bigint;
  /** user active / total active, bps (0 if none). */
  participationBps: number;
  /**
   * User's participation once next epoch's pending issuance (everyone's, including
   * theirs) activates. Lower than participationBps ⇒ dilution.
   */
  participationNextEpochBps: number;
  claimable: bigint;
  claimed: bigint;
  /** Net loss high-water mark on house trades, base units. */
  netLossHighWater: bigint;
  cumulativeNetLoss: bigint;
  /** DIME held in the wallet (unstaked, earns nothing). 18dp. */
  wallet: bigint;
  /** Current DIME per $1 of eligible house loss (18dp), after TVL decay. */
  emissionRateE18: bigint;
  totalSupply: bigint;
  transfersEnabled: boolean;
  /** When DIME transfers are scheduled to open (ms), or null if not scheduled. */
  transfersAt: number | null;
  /** Estimate of this epoch's distribution pool if it closed now (USDC). */
  estimatedPool: bigint;
  provenance: Provenance;
}

/* ------------------------------------------------------------------ history */

export type ActivityKind =
  | "DEPOSIT" | "WITHDRAW" | "INTENT_SIGNED" | "INTENT_EXPIRED" | "INTENT_CANCELLED"
  | "POSITION_OPENED" | "POSITION_SETTLED" | "RIGHTS_ISSUED" | "RIGHTS_ACTIVATED"
  | "DISTRIBUTION_FUNDED" | "CLAIM" | "STATE_CHANGE";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: number;
  title: string;
  detail?: string;
  amount?: bigint;
  txHash?: Hash;
  block?: bigint;
  provenance: Provenance;
}

export interface IndexerStatus {
  connected: boolean;
  indexedBlock: bigint | null;
  indexedHash: Hash | null;
  chainHead: bigint | null;
  lagBlocks: number | null;
  /** Wall-clock lag between chain head time and indexed block time, ms. */
  lagMs: number | null;
  error?: string;
}

export interface TxProgress {
  id: string;
  label: string;
  stage: "SIGN" | "SUBMITTED" | "INCLUDED" | "CONFIRMED" | "INDEXED" | "FAILED";
  txHash?: Hash;
  error?: string;
  startedAt: number;
  updatedAt: number;
}
