/**
 * Fair-value model v2 — an ESTIMATE. The contract settles against a separately verified reference.
 *
 *  1. Per venue: microprice = (bid·askSz + ask·bidSz) / (bidSz + askSz). It leans toward the thinner
 *     side, i.e. where the price is about to move. Venues without sizes fall back to the mid.
 *  2. Quote groups (USD spot, USDT spot, USDC perp) are aligned to an anchor group with an EWMA
 *     basis measured whenever both groups are fresh (perp funding / stablecoin basis).
 *  3. Across venues: WEIGHTED MEDIAN. Weight = EWMA top-of-book notional (liquidity proxy)
 *     × freshness (linear decay to 0 at maxAge), capped at `maxWeightShare` per venue. A median
 *     ignores one bad venue; a weighted mean would be dragged by it.
 *  4. Quality: STALE / INSUFFICIENT / CONFLICT flags — never guess.
 * The plain median of mids is computed alongside for comparison (showcase metric).
 */

export type Quote = "USD" | "USDT" | "USDC_PERP";

export interface SourceTick {
  id: string;
  name: string;
  quote: Quote;
  /** mid or last price (8dp) — kept for compatibility and the plain-median comparison */
  price: bigint;
  bid?: bigint;
  ask?: bigint;
  /** sizes in base units (BTC), 8dp */
  bidSize?: bigint;
  askSize?: bigint;
  ts: number;
  recvAt: number;
  seq: number;
}

export type Quality = "OK" | "STALE" | "CONFLICT" | "INSUFFICIENT";

export interface VenueView {
  id: string;
  quote: Quote;
  mid: bigint;
  micro: bigint;
  adjusted: bigint; // micro + group basis
  depthUsd: number; // EWMA top-of-book notional, USD
  freshness: number; // 0..1
  weight: number; // final normalised weight (0 if excluded)
  ageMs: number;
}

export interface Estimate {
  estimate: bigint;
  plainMedian: bigint;
  divergenceBps: number; // estimate vs plain median
  quality: Quality;
  used: string[];
  disagreementBps: number; // max spread among used adjusted prices
  ageMs: number; // age of freshest source
  basis: Partial<Record<Quote, bigint>>; // group → added to that group's prices
  venues: VenueView[];
}

export interface AggregateParams {
  maxAgeMs: number;
  maxDisagreementBps: number;
  minSources: number;
  maxWeightShare?: number; // default 0.4
  anchor?: Quote; // default USD, falling back to the first fresh group
}

const BPS = 10_000n;
const SCALE = 100_000_000n;

export function microprice(t: Pick<SourceTick, "bid" | "ask" | "bidSize" | "askSize" | "price">): bigint {
  if (t.bid === undefined || t.ask === undefined) return t.price;
  const bs = t.bidSize ?? 0n, as = t.askSize ?? 0n;
  if (bs + as === 0n) return (t.bid + t.ask) / 2n;
  return (t.bid * as + t.ask * bs) / (bs + as);
}

export function median(xs: bigint[]): bigint {
  const a = [...xs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2n;
}

/** Weighted median: smallest price whose cumulative weight reaches half (ties → midpoint). */
export function weightedMedian(points: { price: bigint; weight: number }[]): bigint {
  const a = points.filter((p) => p.weight > 0).sort((x, y) => (x.price < y.price ? -1 : x.price > y.price ? 1 : 0));
  const total = a.reduce((s, p) => s + p.weight, 0);
  let cum = 0;
  for (let i = 0; i < a.length; i++) {
    cum += a[i].weight;
    if (Math.abs(cum - total / 2) < 1e-12 && i + 1 < a.length) return (a[i].price + a[i + 1].price) / 2n;
    if (cum > total / 2) return a[i].price;
  }
  return a[a.length - 1].price;
}

/** Normalise and cap each weight at `cap` share, redistributing the excess (water-filling). */
export function capWeights(ws: number[], cap: number): number[] {
  const n = ws.filter((w) => w > 0).length;
  if (n === 0) return ws.map(() => 0);
  const effCap = Math.max(cap, 1 / n); // cap can't be below an equal split
  let out = ws.map((w) => Math.max(0, w));
  for (let iter = 0; iter < 10; iter++) {
    const total = out.reduce((s, w) => s + w, 0);
    out = out.map((w) => w / total);
    const over = out.filter((w) => w > effCap + 1e-12);
    if (!over.length) break;
    const excess = over.reduce((s, w) => s + (w - effCap), 0);
    const underTotal = out.filter((w) => w > 0 && w < effCap).reduce((s, w) => s + w, 0);
    out = out.map((w) => (w > effCap ? effCap : w > 0 && underTotal > 0 ? w + (excess * w) / underTotal : w));
  }
  return out;
}

export class Aggregator {
  private latest = new Map<string, SourceTick>();
  private depth = new Map<string, number>();
  private basis: Partial<Record<Quote, bigint>> = {};

  constructor(private p: AggregateParams) {}

  update(t: SourceTick) {
    const prev = this.latest.get(t.id);
    if (prev && t.seq <= prev.seq && t.ts <= prev.ts) return false; // duplicate / out-of-order (e.g. from the redundant connection)
    this.latest.set(t.id, t);
    if (t.bidSize !== undefined && t.askSize !== undefined && t.bid !== undefined && t.ask !== undefined) {
      const notional = Number(t.bid * t.bidSize + t.ask * t.askSize) / Number(SCALE * SCALE);
      const prevD = this.depth.get(t.id);
      this.depth.set(t.id, prevD === undefined ? notional : prevD + (notional - prevD) * 0.05);
    }
    return true;
  }

  sources(): SourceTick[] {
    return [...this.latest.values()];
  }

  compute(now: number): Estimate | null {
    const all = this.sources();
    if (!all.length) return null;
    const fresh = all.filter((s) => now - s.recvAt <= this.p.maxAgeMs);
    const groups = new Map<Quote, bigint[]>();
    for (const s of fresh) groups.set(s.quote, [...(groups.get(s.quote) ?? []), microprice(s)]);
    const anchor: Quote | undefined = groups.has(this.p.anchor ?? "USD") ? (this.p.anchor ?? "USD") : [...groups.keys()][0];
    if (anchor) {
      const ref = median(groups.get(anchor)!);
      this.basis[anchor] = 0n;
      for (const [q, xs] of groups) {
        if (q === anchor) continue;
        const b = ref - median(xs);
        const prev = this.basis[q];
        this.basis[q] = prev === undefined ? b : prev + (b - prev) / 16n; // EWMA α = 1/16
      }
    }
    const maxShare = this.p.maxWeightShare ?? 0.4;
    const newest = Math.max(...all.map((s) => s.recvAt));
    const venues: VenueView[] = all.map((s) => {
      const ageMs = Math.max(0, now - s.recvAt);
      const micro = microprice(s);
      const b = this.basis[s.quote];
      const freshness = ageMs >= this.p.maxAgeMs || b === undefined ? 0 : 1 - ageMs / this.p.maxAgeMs;
      return {
        id: s.id, quote: s.quote, mid: s.bid !== undefined && s.ask !== undefined ? (s.bid + s.ask) / 2n : s.price, micro,
        adjusted: micro + (b ?? 0n), depthUsd: this.depth.get(s.id) ?? 0, freshness, weight: 0, ageMs,
      };
    });
    const usable = venues.filter((v) => v.freshness > 0);
    const ageMs = Math.max(0, now - newest);
    const plainMedian = usable.length ? median(usable.map((v) => v.mid + (this.basis[v.quote] ?? 0n))) : median(all.map((s) => s.price));
    if (usable.length < this.p.minSources) {
      return {
        estimate: plainMedian, plainMedian, divergenceBps: 0, quality: fresh.length ? "INSUFFICIENT" : "STALE",
        used: [], disagreementBps: 0, ageMs, basis: { ...this.basis }, venues,
      };
    }
    // Liquidity proxy: venues without size data get the median depth so they still count.
    const depths = usable.map((v) => v.depthUsd).filter((d) => d > 0).sort((a, b) => a - b);
    const typical = depths.length ? depths[depths.length >> 1] : 1;
    const raw = usable.map((v) => (v.depthUsd > 0 ? v.depthUsd : typical) * v.freshness);
    const capped = capWeights(raw, maxShare);
    usable.forEach((v, i) => { v.weight = capped[i]; });
    const estimate = weightedMedian(usable.map((v) => ({ price: v.adjusted, weight: v.weight })));
    let lo = usable[0].adjusted, hi = usable[0].adjusted;
    for (const v of usable) { if (v.adjusted < lo) lo = v.adjusted; if (v.adjusted > hi) hi = v.adjusted; }
    const disagreementBps = Number(((hi - lo) * BPS * 100n) / estimate) / 100;
    const divergenceBps = Number(((estimate - plainMedian) * BPS * 1000n) / estimate) / 1000;
    return {
      estimate, plainMedian, divergenceBps, ageMs, basis: { ...this.basis }, venues,
      quality: disagreementBps > this.p.maxDisagreementBps ? "CONFLICT" : "OK",
      used: usable.map((v) => v.id), disagreementBps,
    };
  }
}
