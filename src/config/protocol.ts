/**
 * Protocol parameters as the frontend understands them.
 *
 * Every number tagged UNVALIDATED is an illustrative starting value, not a tested
 * launch parameter. In live mode these must be read from the contract's active
 * configuration version (see docs/CONTRACTS.md, `IChalkConfig.activeConfig`), and the
 * frontend refuses to sign intents whose configVersion differs from the chain's.
 */
export interface ProtocolParams {
  configVersion: number;
  /** Collateral token decimals. USDC = 6, but verified on-chain in live mode. */
  collateralDecimals: number;
  /** Max cumulative external deposits per wallet, base units. Winnings may exceed. */
  fundingCapPerWallet: bigint;
  minMargin: bigint;
  maxMargin: bigint;
  maxLeverage: number;
  /** Fee on positive realised gross P&L, basis points. UNVALIDATED. */
  profitFeeBps: number;
  /** Liquidate when equity <= this share of collateral, bps. UNVALIDATED. */
  maintenanceBps: number;
  /** House reservation per position as a multiple of collateral. UNVALIDATED. */
  houseReservationMultiple: number;
  /** Protection close fires at this share of reservation if it cannot be extended. UNVALIDATED. */
  protectionTriggerBps: number;
  /** Share of house equity that may be reserved against trader liabilities. UNVALIDATED. */
  houseMaxUtilisationBps: number;
  /** Max |net directional house notional| as a multiple of house equity. UNVALIDATED. */
  houseMaxNetNotionalMultiple: number;
  /** Max concurrent house-backed positions (operational ceiling). UNVALIDATED. */
  maxConcurrentHousePositions: number;
  /** Max concurrent matched pairs (operational ceiling). UNVALIDATED. */
  maxConcurrentMatchedPairs: number;
  /** House gap backstop reserved per matched pair at open, base units. v1 default 0. */
  matchedGapBackstop: bigint;
  /** DIME (18dp) issued per $1 of eligible house loss while the reserve ≤ emissionDecayTvl. UNVALIDATED. */
  dimePerUsdE18: bigint;
  /** Above this house reserve (base units), issuance falls as decayTvl / reserve. UNVALIDATED. */
  emissionDecayTvl: bigint;
  /** Hard cap on DIME issued per epoch (18dp). UNVALIDATED. */
  maxMintPerEpoch: bigint;
  /** A manual stake must leave the holder with at least this much staked (18dp). UNVALIDATED. */
  minStake: bigint;
  /** Max share of eligible new house earnings distributed per epoch, bps. UNVALIDATED. */
  distributionShareBps: number;
  /** Reserve that must remain before any distribution is funded, base units. UNVALIDATED. */
  distributionReserveFloor: bigint;
  epochSeconds: number;
  /** Allowed match windows offered in the ticket, ms. */
  matchWindowsMs: readonly number[];
  /** Intent expiry after signing, ms. */
  intentTtlMs: number;
  defaultSlippageBps: number;
  /** Max price-source age and disagreement before ORACLE_HOLD-style rejection. UNVALIDATED. */
  maxPriceAgeMs: number;
  maxSourceDisagreementBps: number;
  matchedRewardsEnabled: false;
}

export const PRICE_DECIMALS = 8;
export const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);

const usd = (whole: number, decimals = 6) => BigInt(Math.round(whole * 10 ** decimals));

export const defaultParams: ProtocolParams = {
  configVersion: 1,
  collateralDecimals: 6,
  fundingCapPerWallet: usd(10),
  minMargin: usd(0.1),
  maxMargin: usd(2),
  maxLeverage: 1000,
  profitFeeBps: 2500,
  maintenanceBps: 1000,
  houseReservationMultiple: 20,
  protectionTriggerBps: 9000,
  houseMaxUtilisationBps: 8000,
  houseMaxNetNotionalMultiple: 200,
  maxConcurrentHousePositions: 10,
  maxConcurrentMatchedPairs: 25,
  matchedGapBackstop: 0n,
  dimePerUsdE18: 10n ** 17n, // 0.1 DIME per $1
  emissionDecayTvl: usd(1_000_000),
  maxMintPerEpoch: 10_000n * 10n ** 18n,
  minStake: 10n ** 17n, // 0.1 DIME
  distributionShareBps: 2000,
  distributionReserveFloor: usd(10),
  epochSeconds: 24 * 60 * 60,
  matchWindowsMs: [3000, 5000, 10000],
  intentTtlMs: 30_000,
  defaultSlippageBps: 10,
  maxPriceAgeMs: 3000,
  maxSourceDisagreementBps: 15,
  matchedRewardsEnabled: false,
};

export const MARKET = "BTC-USD" as const;
export type Market = typeof MARKET;
