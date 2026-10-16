/* Farming simulator for DIME issuance. Plain floats: this is a what-if model, not accounting.
   One step = one epoch (a day). It follows the contract's order: last epoch's mints activate,
   new house earnings are distributed to active stake, then this epoch's losses mint pending DIME. */

export type Curve = "cubic" | "inverse";
export type Strategy = "hedged" | "oneSided";

export interface SimInputs {
  /** DIME per $1 of eligible loss below the knee. */
  baseRate: number;
  /** House reserve ($) where issuance starts to fall. */
  knee: number;
  curve: Curve;
  reserve0: number;
  /** Profit fee (fraction of a winner's gross P&L). */
  fee: number;
  /** Share of new house earnings paid to stakers. */
  share: number;
  /** Max DIME minted per epoch, all users. 0 = no cap. */
  epochCap: number;
  /** Real traders: eligible (individual net) losses per day, $. */
  organicLoss: number;
  /** Real traders: house net earnings per day, $ (what they lose minus what winners take, plus fees). */
  organicEarnings: number;
  /** DIME already staked by others at day 0. */
  existingStake: number;
  strategy: Strategy;
  /** Farmer's net cost per day, $. Hedged: the fee on the winning leg. One-sided: the expected loss. */
  spend: number;
  /** Count opposing house positions from linked wallets as one, so only the true net loss earns DIME. */
  netLinked: boolean;
  /** Max DIME per wallet per epoch. 0 = off. */
  perWalletCap: number;
  wallets: number;
  days: number;
}

export const DEFAULTS: SimInputs = {
  baseRate: 10,
  knee: 1_000_000,
  curve: "cubic",
  reserve0: 50_000,
  fee: 0.25,
  share: 0.2,
  epochCap: 1_000_000,
  organicLoss: 10_000,
  organicEarnings: 3_000,
  existingStake: 0,
  strategy: "hedged",
  spend: 500,
  netLinked: false,
  perWalletCap: 0,
  wallets: 50,
  days: 180,
};

/** Float mirror of DimeProtocol.emissionRate (and the old 1/x curve, for comparison). */
export function rateAt(base: number, knee: number, reserve: number, curve: Curve): number {
  if (reserve <= knee || reserve <= 0) return base;
  const k = knee / reserve;
  return curve === "cubic" ? base * k * k * k : base * k;
}

export interface Day {
  day: number;
  reserve: number;
  rate: number;
  /** Farmer USDC received minus spend, cumulative. */
  farmerNet: number;
  /** Farmer's share of all DIME (active + pending). */
  farmerShare: number;
  /** USDC paid to real stakers that day. */
  organicPaid: number;
}

export interface SimResult {
  days: Day[];
  farmerCost: number;
  farmerUsdc: number;
  farmerDime: number;
  totalDime: number;
  /** First day the farmer's cumulative net is ≥ 0, or null. */
  paybackDay: number | null;
  organicUsdc: number;
}

export function simulate(p: SimInputs): SimResult {
  let reserve = p.reserve0;
  let fA = 0, fP = 0; // farmer active / pending DIME
  let oA = p.existingStake, oP = 0; // everyone else
  let cost = 0, usdc = 0, oUsdc = 0;
  let payback: number | null = null;
  const days: Day[] = [];

  // Eligible loss per $ of farmer spend. Hedged across wallets: the losing leg's whole margin counts
  // while the cost is only the fee on the winning leg. Netting linked wallets removes that leverage.
  const eligiblePerSpend = p.strategy === "hedged" && !p.netLinked ? 1 / p.fee : 1;

  for (let d = 1; d <= p.days; d++) {
    // 1. Last epoch's mints activate.
    fA += fP; oA += oP; fP = 0; oP = 0;

    // 2. Distribute new house earnings to active stake.
    const earnings = p.organicEarnings + p.spend;
    const pot = Math.max(0, earnings) * p.share;
    const active = fA + oA;
    const toFarmer = active > 0 ? (pot * fA) / active : 0;
    const toOthers = active > 0 ? pot - toFarmer : 0;
    reserve += earnings - toFarmer - toOthers;
    usdc += toFarmer; oUsdc += toOthers; cost += p.spend;

    // 3. This epoch's losses mint pending DIME at the rate for the current reserve.
    const rate = rateAt(p.baseRate, p.knee, reserve, p.curve);
    let mintF = p.spend * eligiblePerSpend * rate;
    if (p.perWalletCap > 0) mintF = Math.min(mintF, p.perWalletCap * p.wallets);
    let mintO = p.organicLoss * rate;
    if (p.epochCap > 0 && mintF + mintO > p.epochCap) {
      const s = p.epochCap / (mintF + mintO);
      mintF *= s; mintO *= s;
    }
    fP += mintF; oP += mintO;

    const net = usdc - cost;
    if (payback === null && p.spend > 0 && net >= 0) payback = d;
    const total = fA + fP + oA + oP;
    days.push({ day: d, reserve, rate, farmerNet: net, farmerShare: total > 0 ? (fA + fP) / total : 0, organicPaid: toOthers });
  }
  return { days, farmerCost: cost, farmerUsdc: usdc, farmerDime: fA + fP, totalDime: fA + fP + oA + oP, paybackDay: payback, organicUsdc: oUsdc };
}

/* ------------------------------------------------------------------ throughput */

export interface Throughput {
  /** Expected round trips per day: time for BTC to move ±1/L is (1/L)² / σ² days. */
  cyclesPerDay: number;
  /** Largest margin per position under the exposure cap. */
  margin: number;
  /** Eligible loss one hedged pair can generate per day. */
  eligiblePerPairDay: number;
  /** Lifetime eligible loss one wallet can generate before it needs outside money again. */
  eligiblePerWalletLifetime: number;
  /** Allow-listed wallets the farmer needs to sustain `spend` for `days`. */
  walletsNeeded: number;
}

export function throughput(p: SimInputs, leverage: number, dailyVol: number, exposureCap: number, depositCap: number): Throughput {
  const margin = exposureCap / leverage;
  const cyclesPerDay = (dailyVol * leverage) ** 2;
  // Hedged: each cycle one leg loses its whole margin. One-sided: on average half the cycles lose.
  const eligiblePerPairDay = margin * cyclesPerDay * (p.strategy === "hedged" ? 1 : 0.5);
  // Hedged legs win and lose in turn, so each wallet drifts down by the fee on its wins; it can churn
  // depositCap / fee of eligible loss. One-sided loses its whole deposit once.
  const eligiblePerWalletLifetime = p.strategy === "hedged" && !p.netLinked ? depositCap / p.fee : depositCap;
  const eligibleNeeded = p.spend * (p.strategy === "hedged" && !p.netLinked ? 1 / p.fee : 1) * p.days;
  const byLifetime = eligibleNeeded / Math.max(1e-9, eligiblePerWalletLifetime);
  const byRate = (p.spend * (p.strategy === "hedged" && !p.netLinked ? 1 / p.fee : 1)) / Math.max(1e-9, eligiblePerPairDay) * (p.strategy === "hedged" ? 2 : 1);
  return { cyclesPerDay, margin, eligiblePerPairDay, eligiblePerWalletLifetime, walletsNeeded: Math.ceil(Math.max(byLifetime, byRate)) };
}
