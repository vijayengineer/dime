/**
 * Auto-execution policy — the user just picks side, margin and leverage; the backend picks the rest.
 * Shared by the backend quote endpoint and the demo engine so both behave identically.
 *
 *  - Route: always try to match with another trader first. Fall back to the house only if the house
 *    can back the trade right now; otherwise match-only with a longer window.
 *  - Window: short when the house is available (fast fill either way), longer when it isn't.
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

export const AUTO_WINDOW_WITH_HOUSE_MS = 3000;
export const AUTO_WINDOW_MATCH_ONLY_MS = 8000;

export function autoExecution(i: AutoExecutionInput): AutoExecution {
  const liqBps = Math.floor((10_000 - i.maintenanceBps) / i.leverage);
  const slippageBps = Math.max(1, Math.min(10, Math.floor(liqBps / 4)));
  if (i.houseAvailable) {
    return {
      routes: { matched: true, houseFallback: true }, matchWindowMs: AUTO_WINDOW_WITH_HOUSE_MS, slippageBps,
      summary: `Matches you with another trader for up to ${AUTO_WINDOW_WITH_HOUSE_MS / 1000}s; if none, the house takes the other side.`,
    };
  }
  return {
    routes: { matched: true, houseFallback: false }, matchWindowMs: AUTO_WINDOW_MATCH_ONLY_MS, slippageBps,
    summary: `House capacity is full, so this only opens if another trader matches within ${AUTO_WINDOW_MATCH_ONLY_MS / 1000}s.`,
  };
}
