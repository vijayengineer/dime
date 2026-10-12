/** Bounded-reservoir latency recorder. Reports sample count and p50/p95/p99 — measured, never estimated. */
export class Latency {
  private buf: Float64Array;
  private n = 0;
  private i = 0;
  constructor(private readonly cap = 20_000) { this.buf = new Float64Array(cap); }
  record(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.buf[this.i] = ms;
    this.i = (this.i + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }
  summary() {
    if (this.n === 0) return { n: 0, p50: null, p95: null, p99: null, max: null };
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    const q = (p: number) => round(a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]);
    return { n: this.n, p50: q(50), p95: q(95), p99: q(99), max: round(a[a.length - 1]) };
  }
}

export class Counters {
  private c = new Map<string, number>();
  inc(k: string, by = 1) { this.c.set(k, (this.c.get(k) ?? 0) + by); }
  get(k: string) { return this.c.get(k) ?? 0; }
  toJSON() { return Object.fromEntries(this.c); }
}

const round = (x: number) => Math.round(x * 1000) / 1000;
