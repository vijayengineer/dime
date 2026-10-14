/**
 * Fair-value model v3 — an ESTIMATE. The contract settles against a separately verified reference.
 *
 *  1. Per venue: microprice = (bid·askSz + ask·bidSz) / (bidSz + askSz). It leans toward the thinner
 *     side, i.e. where the price is about to move. Venues without sizes fall back to the mid.
 *  2. Freshness is measured from the EXCHANGE's own timestamp where the venue provides one (receipt time
 *     only for venues that don't), so delayed data is never treated as fresh (audit H-03). Exchange
 *     timestamps ahead of receipt by more than `maxSkewMs` are rejected as a clock fault.
 *  3. Ordering: per venue, sequence numbers must strictly increase (and exchange timestamps never go
 *     back). An older update arriving late on a redundant connection is dropped; a lower sequence is only
 *     accepted after a reconnect gap (`resetGapMs`) (audit H-03).
 *  4. Quote groups (USD spot, USDT spot, USDC perp) are aligned to the USD group with a basis that is
 *     learned ONLY while at least `minAnchorSources` independent, agreeing USD venues are fresh, updated
 *     on new observations with elapsed-time weighting, bounded per step and in absolute size. compute()
 *     is a pure snapshot and never changes the basis (audit H-02).
 *  5. Across venues: WEIGHTED MEDIAN. Weight = EWMA top-of-book notional (liquidity proxy)
 *     × freshness (linear decay to 0 at maxAge), capped at `maxWeightShare` per venue.
 *  6. Quality: OK needs at least `minSources` venues (so the 40% cap genuinely holds) and agreement both
 *     inside the anchor group and across groups after adjustment. Otherwise CONFLICT / DEGRADED /
 *     INSUFFICIENT / STALE. DEGRADED (one fallback venue) is for settlement only — it can never open a
 *     position (audit H-04; enforced on-chain through the signed quality and venue count).
 * The plain median of mids is computed alongside for comparison (showcase metric).
 */

export const MODEL_VERSION = "dime-fv-3";

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
  /** exchange timestamp when the venue provides one, otherwise the receipt time */
  ts: number;
  recvAt: number;
  seq: number;
  /** true when `ts` is the exchange's own time (default: ts !== recvAt) */
  hasSourceTs?: boolean;
}

/** DEGRADED = too few fresh venues; the estimate is one fallback venue (basis-adjusted, settlement only). */
export type Quality = "OK" | "DEGRADED" | "STALE" | "CONFLICT" | "INSUFFICIENT";

export interface VenueView {
  id: string;
  quote: Quote;
  mid: bigint;
  micro: bigint;
  adjusted: bigint; // micro + group basis
  depthUsd: number; // EWMA top-of-book notional, USD
  freshness: number; // 0..1
  weight: number; // final normalised weight (0 if excluded)
  ageMs: number; // age of the observation (exchange time where available)
  obsMs: number; // observation time used for freshness
}

export interface Estimate {
  estimate: bigint;
  plainMedian: bigint;
  divergenceBps: number; // estimate vs plain median
  quality: Quality;
  used: string[];
  disagreementBps: number; // max spread among used adjusted prices (after basis)
  rawDisagreementBps: number; // max spread inside any quote group (before basis)
  anchorSources: number; // fresh USD venues behind the basis
  ageMs: number; // age of the freshest observation
  obsMs: number; // OLDEST observation behind the estimate (conservative), 0 when none
  basis: Partial<Record<Quote, bigint>>; // group → added to that group's prices
  venues: VenueView[];
}

export interface AggregateParams {
  maxAgeMs: number;
  maxDisagreementBps: number;
  /** venues needed for OK (default 3, so a 40% cap can actually hold) */
  minSources: number;
  maxWeightShare?: number; // default 0.4
  anchor?: Quote; // default USD
  /** Venue used alone when fewer than minSources are fresh (default "hyperliquid"); null disables. */
  degradedFallback?: string | null;
  /** exchange timestamps may lead receipt by at most this (clock skew), default 1000 ms */
  maxSkewMs?: number;
  /** a lower sequence is accepted only after this long without updates (reconnect), default 5000 ms */
  resetGapMs?: number;
  /** independent fresh anchor venues required to learn the basis, default 2 */
  minAnchorSources?: number;
  /** basis EWMA time constant, default 60 s */
  basisTauMs?: number;
  /** largest basis move per update, bps of price, default 5 */
  maxBasisStepBps?: number;
  /** largest basis allowed at all, bps; a group beyond it is excluded, default 100 */
  maxBasisBps?: number;
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

const spreadBps = (xs: bigint[]) => {
  if (xs.length < 2) return 0;
  let lo = xs[0], hi = xs[0];
  for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x; }
  return Number(((hi - lo) * BPS * 100n) / lo) / 100;
};

export type RejectReason = "skew" | "order";

export class Aggregator {
  private latest = new Map<string, SourceTick>();
  private depth = new Map<string, number>();
  private basis: Partial<Record<Quote, bigint>> = {};
  private basisAt: Partial<Record<Quote, number>> = {};
  readonly rejected: Record<RejectReason, number> = { skew: 0, order: 0 };

  constructor(private p: AggregateParams) {}

  private hasTs(t: SourceTick) { return t.hasSourceTs ?? t.ts !== t.recvAt; }
  /** Observation time used for freshness: the exchange's time when it has one (never later than receipt). */
  obsTime(t: SourceTick) { return this.hasTs(t) ? Math.min(t.ts, t.recvAt) : t.recvAt; }

  /** Accept a tick if it is newer than what we have for the venue. Returns false (and counts why) if not. */
  update(t: SourceTick) {
    const skew = this.p.maxSkewMs ?? 1000;
    if (this.hasTs(t) && t.ts > t.recvAt + skew) { this.rejected.skew++; return false; }
    const prev = this.latest.get(t.id);
    if (prev) {
      const reconnect = t.recvAt - prev.recvAt > (this.p.resetGapMs ?? 5000);
      if (!reconnect && (t.seq <= prev.seq || (this.hasTs(t) && this.hasTs(prev) && t.ts < prev.ts))) {
        this.rejected.order++;
        return false; // duplicate or older update (e.g. from the redundant connection)
      }
    }
    this.latest.set(t.id, t);
    if (t.bidSize !== undefined && t.askSize !== undefined && t.bid !== undefined && t.ask !== undefined) {
      const notional = Number(t.bid * t.bidSize + t.ask * t.askSize) / Number(SCALE * SCALE);
      const prevD = this.depth.get(t.id);
      this.depth.set(t.id, prevD === undefined ? notional : prevD + (notional - prevD) * 0.05);
    }
    this.learnBasis(t.recvAt);
    return true;
  }

  sources(): SourceTick[] {
    return [...this.latest.values()];
  }

  basisState() {
    return { basis: { ...this.basis }, updatedAt: { ...this.basisAt } };
  }

  private freshGroups(now: number) {
    const groups = new Map<Quote, bigint[]>();
    for (const s of this.latest.values()) {
      if (now - this.obsTime(s) > this.p.maxAgeMs) continue;
      groups.set(s.quote, [...(groups.get(s.quote) ?? []), microprice(s)]);
    }
    return groups;
  }

  /**
   * Basis learning — runs on new observations only. Needs an independent, agreeing anchor; bounded per
   * step and weighted by elapsed time, so one venue cannot drag other groups onto itself (audit H-02).
   */
  private learnBasis(now: number) {
    const anchor = this.p.anchor ?? "USD";
    const groups = this.freshGroups(now);
    const ref = groups.get(anchor);
    if (!ref || ref.length < (this.p.minAnchorSources ?? 2) || spreadBps(ref) > this.p.maxDisagreementBps) return;
    const refPx = median(ref);
    this.basis[anchor] = 0n;
    const tau = this.p.basisTauMs ?? 60_000;
    const step = (refPx * BigInt(this.p.maxBasisStepBps ?? 5)) / BPS;
    const absMax = (refPx * BigInt(this.p.maxBasisBps ?? 100)) / BPS;
    for (const [q, xs] of groups) {
      if (q === anchor) continue;
      const sample = refPx - median(xs);
      if (sample > absMax || sample < -absMax) continue; // implausible basis: never learn it
      const prev = this.basis[q];
      if (prev === undefined) { this.basis[q] = sample; this.basisAt[q] = now; continue; }
      const dt = now - (this.basisAt[q] ?? now);
      if (dt <= 0) continue;
      let d = sample - prev;
      if (d > step) d = step;
      if (d < -step) d = -step;
      const alphaPpm = BigInt(Math.round(Math.min(1, dt / tau) * 1_000_000));
      this.basis[q] = prev + (d * alphaPpm) / 1_000_000n;
      this.basisAt[q] = now;
    }
  }

  /** Pure snapshot: reads state, never changes it. */
  compute(now: number): Estimate | null {
    const all = this.sources();
    if (!all.length) return null;
    const anchor = this.p.anchor ?? "USD";
    const absMax = (q: Quote, px: bigint) => q === anchor ? true : (() => {
      const b = this.basis[q];
      if (b === undefined) return false;
      const lim = (px * BigInt(this.p.maxBasisBps ?? 100)) / BPS;
      return b <= lim && b >= -lim;
    })();
    const maxShare = this.p.maxWeightShare ?? 0.4;
    const venues: VenueView[] = all.map((s) => {
      const obsMs = this.obsTime(s);
      const ageMs = Math.max(0, now - obsMs);
      const micro = microprice(s);
      const b = s.quote === anchor ? 0n : this.basis[s.quote];
      const ok = ageMs < this.p.maxAgeMs && b !== undefined && absMax(s.quote, micro);
      const freshness = ok ? 1 - ageMs / this.p.maxAgeMs : 0;
      return {
        id: s.id, quote: s.quote, mid: s.bid !== undefined && s.ask !== undefined ? (s.bid + s.ask) / 2n : s.price, micro,
        adjusted: micro + (b ?? 0n), depthUsd: this.depth.get(s.id) ?? 0, freshness, weight: 0, ageMs, obsMs,
      };
    });
    const fresh = venues.filter((v) => v.ageMs < this.p.maxAgeMs);
    const usable = venues.filter((v) => v.freshness > 0);
    const ageMs = Math.min(...venues.map((v) => v.ageMs));
    const byGroup = new Map<Quote, bigint[]>();
    for (const v of fresh) byGroup.set(v.quote, [...(byGroup.get(v.quote) ?? []), v.micro]);
    const rawDisagreementBps = Math.max(0, ...[...byGroup.values()].map(spreadBps));
    const anchorSources = byGroup.get(anchor)?.length ?? 0;
    const anchorSpread = spreadBps(byGroup.get(anchor) ?? []);
    const basisOut = { ...this.basis };
    const plainMedian = usable.length ? median(usable.map((v) => v.mid + (v.quote === anchor ? 0n : this.basis[v.quote] ?? 0n))) : median(all.map((s) => s.price));

    if (usable.length < this.p.minSources) {
      // Degraded mode: one fresh, basis-aligned fallback venue (Hyperliquid by default). Settlement only.
      const fb = this.p.degradedFallback === undefined ? "hyperliquid" : this.p.degradedFallback;
      const v = fb ? usable.find((u) => u.id === fb) : undefined;
      if (v) {
        v.weight = 1;
        return {
          estimate: v.adjusted, plainMedian, divergenceBps: 0, quality: "DEGRADED", used: [v.id],
          disagreementBps: 0, rawDisagreementBps, anchorSources, ageMs, obsMs: v.obsMs, basis: basisOut, venues,
        };
      }
      return {
        estimate: plainMedian, plainMedian, divergenceBps: 0, quality: fresh.length ? "INSUFFICIENT" : "STALE",
        used: [], disagreementBps: 0, rawDisagreementBps, anchorSources, ageMs, obsMs: 0, basis: basisOut, venues,
      };
    }
    // Liquidity proxy: venues without size data get the median depth so they still count.
    const depths = usable.map((v) => v.depthUsd).filter((d) => d > 0).sort((a, b) => a - b);
    const typical = depths.length ? depths[depths.length >> 1] : 1;
    const raw = usable.map((v) => (v.depthUsd > 0 ? v.depthUsd : typical) * v.freshness);
    const capped = capWeights(raw, maxShare);
    usable.forEach((v, i) => { v.weight = capped[i]; });
    const estimate = weightedMedian(usable.map((v) => ({ price: v.adjusted, weight: v.weight })));
    const disagreementBps = spreadBps(usable.map((v) => v.adjusted));
    const divergenceBps = Number(((estimate - plainMedian) * BPS * 1000n) / estimate) / 1000;
    const conflict = disagreementBps > this.p.maxDisagreementBps || anchorSpread > this.p.maxDisagreementBps;
    return {
      estimate, plainMedian, divergenceBps, ageMs, basis: basisOut, venues,
      quality: conflict ? "CONFLICT" : "OK",
      used: usable.map((v) => v.id), disagreementBps, rawDisagreementBps, anchorSources,
      obsMs: Math.min(...usable.map((v) => v.obsMs)),
    };
  }
}
