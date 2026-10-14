/**
 * Auto-execution policy — the user just picks side, margin and leverage; the backend picks the rest.
 * Shared by the backend quote endpoint and the demo engine so both behave identically.
 *
 *  - Route: the house takes the other side immediately whenever it can back the trade (house-only
 *    intent, no matching window, opens in about a second). Peer matching is the overflow path, used
 *    only when the house is full: match-only with a short window.
 *  - Price tolerance: ¼ of the liquidation distance, between 1 and 10 bp, so a fill can never land
 *    near liquidation.
 * The user still authorises all of this: it is in the signed intent and shown on the review sheet.
 */
export interface AutoExecutionInput {
  leverage: number;
  maintenanceBps: number;
  houseAvailable: boolean;
}

export interface AutoExecution {
  routes: { matched: boolean; houseFallback: boolean };
  matchWindowMs: number;
  slippageBps: number;
  summary: string;
}

export const AUTO_WINDOW_MATCH_ONLY_MS = 8000;

/**
 * Exposure cap: margin × leverage never exceeds $100 (USDC, 6 decimals). Bigger margins get less leverage
 * ($0.10 → 1000×, $1 → 100×), so every position has the same worst-case size and the house can reserve less per trade.
 */
export const MAX_NOTIONAL = 100_000_000n;
export function maxLeverageFor(collateral: bigint, protocolMax: number): number {
  if (collateral <= 0n) return protocolMax;
  return Math.max(1, Math.min(protocolMax, Number(MAX_NOTIONAL / collateral)));
}

export function autoExecution(i: AutoExecutionInput): AutoExecution {
  const liqBps = Math.floor((10_000 - i.maintenanceBps) / i.leverage);
  const slippageBps = Math.max(1, Math.min(10, Math.floor(liqBps / 4)));
  if (i.houseAvailable) {
    return {
      routes: { matched: false, houseFallback: true }, matchWindowMs: 0, slippageBps,
      summary: "The house takes the other side straight away.",
    };
  }
  return {
    routes: { matched: true, houseFallback: false }, matchWindowMs: AUTO_WINDOW_MATCH_ONLY_MS, slippageBps,
    summary: `The house is full right now, so this opens only if another trader takes the other side within ${AUTO_WINDOW_MATCH_ONLY_MS / 1000}s.`,
  };
}
