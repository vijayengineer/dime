import { MARKET } from "@/config/protocol";
import type { PriceSnapshot } from "@/domain/types";

/** Decodes the pricing service's snapshot (string amounts) into the domain type. Shared by live and demo-live-feed modes. */
export function decodePriceWire(d: Record<string, any>, liveMarketData = true): PriceSnapshot {
  const big = (v: unknown) => BigInt(v as string);
  return {
    market: MARKET,
    estimate: big(d.estimate),
    reference: d.reference ? { price: big(d.reference.price), ts: Number(d.reference.ts), verifier: String(d.reference.verifier) } : null,
    sources: (d.sources ?? []).map((s: Record<string, any>) => ({
      id: String(s.id), name: String(s.name), price: big(s.price), ts: Number(s.ts), seq: Number(s.seq),
      quote: s.quote, weight: s.weight, depthUsd: s.depthUsd, ageMs: s.ageMs, used: s.used, health: s.health ?? null,
    })),
    ageMs: Number(d.ageMs),
    disagreementBps: Number(d.disagreementBps),
    referenceDeviationBps: d.referenceDeviationBps == null ? null : Number(d.referenceDeviationBps),
    quality: d.quality,
    receivedAt: Date.now(),
    liveMarketData,
    method: d.method,
    plainMedian: d.plainMedian ? big(d.plainMedian) : undefined,
    divergenceBps: d.divergenceBps,
    crossChecks: d.crossChecks?.hyperliquidOracle
      ? { hyperliquidOracle: { price: big(d.crossChecks.hyperliquidOracle.price), ts: Number(d.crossChecks.hyperliquidOracle.ts), deviationBps: Number(d.crossChecks.hyperliquidOracle.deviationBps) } }
      : undefined,
    availability: d.availability,
  };
}
