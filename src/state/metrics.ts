/**
 * Client-side performance measurement. Records what this browser actually observed —
 * the same code runs in demo and live mode, so demo numbers measure simulated delays
 * and must be labelled as such. Nothing here is invented or extrapolated.
 */
export type MetricKey =
  | "quoteLatencyMs"
  | "matchWaitMs"
  | "submitToOpenMs"
  | "closeToSettledMs"
  | "eventToScreenMs";

export type OutcomeKey = "matched" | "houseFallback" | "expired" | "capacityUnavailable" | "rejected" | "cancelled" | "stalePriceRejected";

const samples: Record<MetricKey, number[]> = {
  quoteLatencyMs: [], matchWaitMs: [], submitToOpenMs: [], closeToSettledMs: [], eventToScreenMs: [],
};
const outcomes: Record<OutcomeKey, number> = {
  matched: 0, houseFallback: 0, expired: 0, capacityUnavailable: 0, rejected: 0, cancelled: 0, stalePriceRejected: 0,
};
const listeners = new Set<() => void>();
let version = 0;

export function record(key: MetricKey, ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const arr = samples[key];
  arr.push(ms);
  if (arr.length > 1000) arr.shift();
  bump();
}
export function count(key: OutcomeKey) { outcomes[key]++; bump(); }
function bump() { version++; listeners.forEach((l) => l()); }

export function subscribeMetrics(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
export function metricsVersion() { return version; }

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function summary() {
  const out = {} as Record<MetricKey, { n: number; p50: number | null; p95: number | null; p99: number | null }>;
  for (const k of Object.keys(samples) as MetricKey[]) {
    const s = [...samples[k]].sort((a, b) => a - b);
    out[k] = { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99) };
  }
  return { latency: out, outcomes: { ...outcomes } };
}
