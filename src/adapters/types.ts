import type { ProtocolParams } from "@/config/protocol";
import type {
  Address, Account, ActivityItem, Balances, HouseSnapshot, IndexerStatus, IntentState, OrderDraft, Position,
  PricePoint, PriceSnapshot, Quote, RightsSnapshot, Settlement, TxProgress,
} from "@/domain/types";

/**
 * Adapter contracts between the UI and the outside world. The UI depends only on
 * these interfaces. `demo/` implements them with a deterministic local engine;
 * `live/` implements them against the services in docs/API.md and the contracts in
 * docs/CONTRACTS.md. A live adapter that fails must surface `ServiceError` — it must
 * never substitute demo data.
 */

export type Unsubscribe = () => void;
export type Listener<T> = (value: T) => void;

/** Value-or-error wrapper so subscriptions can report failures explicitly. */
export type Feed<T> =
  | { status: "loading" }
  | { status: "ok"; value: T; at: number }
  | { status: "error"; error: string; at: number; last?: T };

export class ServiceError extends Error {
  constructor(public service: string, message: string, public retryable = true) {
    super(`${service}: ${message}`);
  }
}

export interface WalletAdapter {
  readonly kind: "privy" | "demo";
  subscribe(cb: Listener<Feed<Account | null>>): Unsubscribe;
  login(): Promise<void>;
  logout(): Promise<void>;
}

export interface AccountAdapter {
  subscribeBalances(cb: Listener<Feed<Balances>>): Unsubscribe;
  /** Approve + deposit USDC into the vault. Enforces the per-wallet funding cap on-chain. */
  deposit(amount: bigint): Promise<TxProgress>;
  withdraw(amount: bigint): Promise<TxProgress>;
}

export interface MarketAdapter {
  subscribePrice(cb: Listener<Feed<PriceSnapshot>>): Unsubscribe;
  /** Recent indicative history for the chart. */
  history(limit: number): Promise<PricePoint[]>;
}

export interface ConfigAdapter {
  /** Active on-chain configuration. Intents must be signed against this version. */
  subscribe(cb: Listener<Feed<ProtocolParams>>): Unsubscribe;
}

export interface IntentAdapter {
  quote(draft: OrderDraft): Promise<Quote>;
  /** Builds the EIP-712 intent, asks the wallet to sign, then submits it to admission. */
  submit(quote: Quote): Promise<IntentState>;
  cancel(intentId: string): Promise<void>;
  /** The caller's current (non-terminal or most recent) intent. */
  subscribe(cb: Listener<Feed<IntentState | null>>): Unsubscribe;
}

export interface PositionAdapter {
  /** At most one active position per wallet in v1. */
  subscribe(cb: Listener<Feed<Position | null>>): Unsubscribe;
  requestClose(positionId: string): Promise<TxProgress>;
  /** Fires once per settlement of the caller's positions (including counterparty-triggered). */
  onSettled(cb: Listener<Settlement>): Unsubscribe;
}

export interface HouseAdapter {
  subscribe(cb: Listener<Feed<HouseSnapshot>>): Unsubscribe;
}

export interface RightsAdapter {
  subscribe(cb: Listener<Feed<RightsSnapshot>>): Unsubscribe;
  claim(): Promise<TxProgress>;
  /** Stake DIME from the wallet (activates next epoch). */
  stake(amount: bigint): Promise<TxProgress>;
  /** Unstake DIME to the wallet (pending first, then active). */
  unstake(amount: bigint): Promise<TxProgress>;
}

export interface HistoryAdapter {
  /** Envio-indexed activity for the account. */
  subscribe(cb: Listener<Feed<ActivityItem[]>>): Unsubscribe;
  subscribeIndexer(cb: Listener<Feed<IndexerStatus>>): Unsubscribe;
}

export interface TxAdapter {
  subscribe(cb: Listener<TxProgress[]>): Unsubscribe;
}

/** Joining the live test: signed Terms of Use plus, while invite-only, a capped invite code. Enforced by the API. */
export interface AccessStatus {
  terms: boolean;
  invited: boolean;
  inviteOnly: boolean;
  slotsLeft: number | null;
  maxWallets: number | null;
}
export interface AccessAdapter {
  status(address: Address): Promise<AccessStatus>;
  /** Signs the current terms with the wallet and submits them with the invite code. */
  join(address: Address, code: string): Promise<AccessStatus>;
}

/** Demo-only controls. Absent in live mode. */
export interface DemoControls {
  scenario: DemoScenario;
  subscribe(cb: Listener<DemoScenario>): Unsubscribe;
  setScenario(patch: Partial<DemoScenario>): void;
  advanceEpoch(): void;
  counterpartyClose(): void;
  priceShock(bps: number): void;
  /** True when demo prices come from the live pricing feed (shocks disabled). */
  readonly liveFeed: boolean;
  /** Settle a house trade for a labelled fixture wallet (net result, base units). */
  fixtureHouseResult(net: bigint): void;
  /** Settle a house loss for the signed-in demo user (from free balance). */
  demoUserHouseLoss(amount: bigint): void;
  reset(): void;
}

export interface DemoScenario {
  counterparty: "available" | "none";
  houseCapacity: "normal" | "exhausted";
  oracle: "ok" | "stale" | "conflict";
  protocolState: "OPEN" | "CLOSE_ONLY" | "ORACLE_HOLD" | "WIND_DOWN";
}

export interface Services {
  mode: "demo" | "live";
  chain: { id: number; name: string; explorer: string | null };
  wallet: WalletAdapter;
  account: AccountAdapter;
  market: MarketAdapter;
  config: ConfigAdapter;
  intents: IntentAdapter;
  positions: PositionAdapter;
  house: HouseAdapter;
  rights: RightsAdapter;
  history: HistoryAdapter;
  tx: TxAdapter;
  access: AccessAdapter;
  demo?: DemoControls;
}
