/**
 * DEMO ENGINE — a deterministic, in-browser stand-in for the backend, contracts and
 * indexer. It exists so the frontend can be built and reviewed end to end before live
 * services exist. Everything it produces is labelled DEMO in the UI.
 *
 * It is NOT a reference implementation of the protocol. It does reuse the bigint
 * domain maths in src/domain (which is unit tested) so that displayed numbers follow
 * the specified accounting rules, but its matching, admission, keeper and indexer
 * behaviour are simplified simulations with artificial delays.
 */
import { defaultParams, MARKET, PRICE_SCALE, type ProtocolParams } from "@/config/protocol";
import { BPS, abs, max } from "@/domain/fixed";
import {
  admitHouseTrade, cappedGrossPnl, exampleNetProfit, houseAvailableCapacity, isLiquidatable,
  liquidationPrice, notionalOf, protectionCheck, settle, settleMatchedPair, slippageLimit, dir,
} from "@/domain/math";
import {
  activateIfDue, advanceEpoch, applyFunding, claim, claimable, computeFunding, effectiveActive, emissionRate,
  newRightsGlobal, newUserRights, participationBps, recordHouseEarnings, recordHouseResult, stake as stakeDime, unstake as unstakeDime,
  type RightsGlobal, type UserRights,
} from "@/domain/rights";
import type {
  Account, ActivityItem, ActivityKind, Address, Balances, CloseReason, Hash, HouseSnapshot, IndexerStatus,
  IntentState, IntentStatus, OrderDraft, Position, PricePoint, PriceSnapshot, ProtocolState, Quote,
  RightsSnapshot, Settlement, TxProgress,
} from "@/domain/types";
import { reasonText } from "@/domain/copy";
import { Emitter, FeedHub } from "../feed";
import { autoExecution } from "@shared/execution";
import { decodePriceWire } from "../priceWire";
import type { DemoScenario } from "../types";

const usd = (n: number) => BigInt(Math.round(n * 1e6));

/* ------------------------------------------------------------ deterministic rng */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(r: () => number) {
  const u = Math.max(r(), 1e-12), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function pseudoHash(n: number, salt: string): Hash {
  let h = 2166136261 ^ n;
  let out = "";
  for (let i = 0; i < 8; i++) {
    for (const c of salt + i) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return `0x${out}` as Hash;
}

const DEMO_USER: Account = { address: "0xDe0000000000000000000000000000000000dEm0" as Address, userId: "demo", label: "Demo wallet" };
const TICK_MS = 1000;
const SIGMA_BPS = 0.8; // per-tick synthetic volatility (~BTC 1s scale, illustrative)
const INDEX_DELAY_MS = 900; // simulated indexer lag

export const defaultScenario: DemoScenario = {
  counterparty: "available", houseCapacity: "normal", oracle: "ok", protocolState: "OPEN",
};

interface MatchedPairState { user: Position; counterparty: Position }

export class DemoEngine {
  params: ProtocolParams = { ...defaultParams };
  scenario: DemoScenario = { ...defaultScenario };

  readonly account = new FeedHub<Account | null>();
  readonly balancesFeed = new FeedHub<Balances>();
  readonly priceFeed = new FeedHub<PriceSnapshot>();
  readonly configFeed = new FeedHub<ProtocolParams>();
  readonly intentFeed = new FeedHub<IntentState | null>();
  readonly positionFeed = new FeedHub<Position | null>();
  readonly houseFeed = new FeedHub<HouseSnapshot>();
  readonly rightsFeed = new FeedHub<RightsSnapshot>();
  readonly historyFeed = new FeedHub<ActivityItem[]>();
  readonly indexerFeed = new FeedHub<IndexerStatus>();
  readonly settled = new Emitter<Settlement>();
  readonly txs = new Emitter<TxProgress[]>();
  readonly scenarioChanged = new Emitter<DemoScenario>();

  private rand = mulberry32(0xc4a1c);
  private price = 100_000n * PRICE_SCALE;
  private seq = 0;
  private history: PricePoint[] = [];
  private lastSourceTs = 0;
  private reference: { price: bigint; ts: number } | null = null;

  private loggedIn = false;
  private wallet = usd(25);
  private free = 0n;
  private pendingCollateral = 0n;
  private depositedTotal = 0n;

  private intent: IntentState | null = null;
  private intentTimers: ReturnType<typeof setTimeout>[] = [];
  private position: Position | null = null;
  private pair: MatchedPairState | null = null;
  private closing = false;

  // house accounting
  private reserve = usd(10);
  private fixtureReserved = 0n;
  private collectedLosses = 0n;
  private netWinningPayouts = 0n;
  private matchedFees = 0n;
  private fundedUnclaimed = 0n;
  private gapPaid = 0n;

  private g: RightsGlobal = newRightsGlobal();
  private dimeWallet = 0n;
  private dimeSupply = 0n;
  private me: UserRights = newUserRights();
  private fixtureUsers = new Map<string, UserRights>();

  private block = 18_400_000n;
  private chainEvents: ActivityItem[] = [];
  private indexed: ActivityItem[] = [];
  private txList: TxProgress[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private nonce = 0;

  /** Live market data mode: prices from the pricing service's public /feed; trading stays simulated. */
  private feedUrl: string | null = null;
  private feedWs: WebSocket | null = null;
  private external: PriceSnapshot | null = null;
  private feedAt = 0;
  private feedAttempt = 0;
  get liveFeed() { return this.feedUrl !== null; }

  constructor() {
    this.seedHistory();
    this.replayFixtures();
    this.configFeed.ok(this.params);
    this.account.ok(null);
    this.publishAll();
  }

  /* ----------------------------------------------------------------- lifecycle */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reset() {
    this.stop();
    this.intentTimers.forEach(clearTimeout);
    const feed = this.feedUrl;
    this.feedUrl = null;
    this.feedWs?.close();
    const fresh = new DemoEngine();
    // copy fresh state onto this instance, keeping subscriber hubs
    const keep = new Set(["account", "balancesFeed", "priceFeed", "configFeed", "intentFeed", "positionFeed", "houseFeed", "rightsFeed", "historyFeed", "indexerFeed", "settled", "txs", "scenarioChanged"]);
    for (const k of Object.keys(fresh) as (keyof DemoEngine)[]) {
      if (!keep.has(k as string)) (this as Record<string, unknown>)[k as string] = (fresh as unknown as Record<string, unknown>)[k as string];
    }
    this.scenarioChanged.emit(this.scenario);
    this.account.ok(null);
    this.intentFeed.ok(null);
    this.txs.emit([]);
    if (feed) this.attachFeed(feed);
    this.publishAll();
    this.start();
  }

  /* ------------------------------------------------------------------- pricing */
  private seedHistory() {
    const now = Date.now();
    const pts: PricePoint[] = [];
    for (let i = 300; i > 0; i--) {
      this.stepPrice();
      pts.push({ t: now - i * TICK_MS, price: this.price });
    }
    this.history = pts;
    this.lastSourceTs = now;
    this.reference = { price: this.price, ts: now };
  }

  private stepPrice() {
    const z = gaussian(this.rand);
    const stepE4 = BigInt(Math.round(z * SIGMA_BPS * 100)); // in 0.01 bps
    this.price += (this.price * stepE4) / 1_000_000n;
    this.seq++;
  }

  private tick() {
    const now = Date.now();
    if (this.feedUrl) {
      this.block += 2n;
      this.publishPrice();
      this.runKeepers();
      this.publishPosition();
      this.publishHouse();
      this.publishIndexer();
      return;
    }
    if (this.scenario.oracle !== "stale") {
      this.stepPrice();
      this.lastSourceTs = now;
      this.history.push({ t: now, price: this.price });
      if (this.history.length > 900) this.history.shift();
      if (this.seq % 2 === 0 || !this.reference) this.reference = { price: this.price, ts: now };
    }
    this.block += 2n;
    this.publishPrice();
    this.runKeepers();
    this.publishPosition();
    this.publishHouse();
    this.publishIndexer();
  }

  private snapshot(): PriceSnapshot {
    const now = Date.now();
    if (this.feedUrl) {
      const ext = this.external;
      if (!ext) {
        return { market: MARKET, estimate: this.price, reference: null, sources: [], ageMs: Infinity, disagreementBps: 0, referenceDeviationBps: null, quality: "INSUFFICIENT", receivedAt: now, liveMarketData: true };
      }
      const age = now - this.feedAt;
      let quality = age > this.params.maxPriceAgeMs ? "STALE" as const : ext.quality;
      if (this.scenario.oracle === "stale") quality = "STALE";
      if (this.scenario.oracle === "conflict") quality = "CONFLICT";
      return { ...ext, ageMs: ext.ageMs + age, quality, receivedAt: now,
        reference: this.reference ? { price: this.reference.price, ts: this.reference.ts, verifier: "Demo settlement reference = live estimate (simulated settlement)" } : null };
    }
    const p = this.price;
    const offA = (p * BigInt(Math.round(gaussian(this.rand) * 30))) / 1_000_000n; // ±0.3bps noise
    const conflict = this.scenario.oracle === "conflict" ? (p * 40n) / BPS : 0n;
    const sources = [
      { id: "src-a", name: "Demo source A (synthetic)", price: p + offA, ts: this.lastSourceTs, seq: this.seq },
      { id: "src-b", name: "Demo source B (synthetic)", price: p - offA + conflict, ts: this.lastSourceTs - 120, seq: this.seq },
      { id: "src-c", name: "Demo source C (synthetic)", price: p, ts: this.lastSourceTs - 260, seq: this.seq },
    ];
    const prices = sources.map((s) => s.price).sort((a, b) => (a < b ? -1 : 1));
    const estimate = prices[1];
    const spread = prices[2] - prices[0];
    const disagreementBps = Number((spread * BPS) / estimate);
    const ageMs = now - this.lastSourceTs;
    const ref = this.reference;
    let quality: PriceSnapshot["quality"] = "OK";
    if (ageMs > this.params.maxPriceAgeMs) quality = "STALE";
    else if (disagreementBps > this.params.maxSourceDisagreementBps) quality = "CONFLICT";
    return {
      market: MARKET, estimate,
      reference: ref ? { price: ref.price, ts: ref.ts, verifier: "Demo reference (synthetic)" } : null,
      sources, ageMs, disagreementBps,
      referenceDeviationBps: ref ? Number((abs(estimate - ref.price) * BPS) / ref.price) : null,
      quality, receivedAt: now,
    };
  }

  private publishPrice() {
    // Live-feed mode: publish nothing until the first real snapshot — never a synthetic placeholder.
    if (this.feedUrl && !this.external) return;
    this.priceFeed.ok(this.snapshot());
  }

  priceHistory(limit: number) { return this.history.slice(-limit); }

  priceShock(bps: number) {
    if (this.feedUrl) return; // real market data: no synthetic shocks
    this.price += (this.price * BigInt(bps)) / BPS;
    this.reference = { price: this.price, ts: Date.now() };
    this.history.push({ t: Date.now(), price: this.price });
    this.tick();
  }

  attachFeed(url: string) {
    this.feedUrl = url;
    this.external = null;
    this.history = []; // never show synthetic history alongside live data
    this.priceFeed.reset(); // drop the synthetic snapshot published by the constructor
    const httpBase = url.replace(/^ws/, "http").replace(/\/feed$/, "");
    fetch(`${httpBase}/feed/history?limit=600`).then((r) => r.json()).then((j: { points: { t: number; price: string }[] }) => {
      if (j.points?.length) this.history = j.points.map((p) => ({ t: p.t, price: BigInt(p.price) }));
    }).catch(() => { /* chart fills from the stream instead */ });
    const open = () => {
      if (!this.feedUrl || typeof WebSocket === "undefined") return;
      const ws = new WebSocket(url);
      this.feedWs = ws;
      ws.onopen = () => { this.feedAttempt = 0; };
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { type: string; data: Record<string, unknown> };
        if (m.type !== "snapshot") return;
        const snap = decodePriceWire(m.data as Record<string, never>);
        this.external = snap;
        this.feedAt = Date.now();
        if (snap.quality === "OK" || snap.quality === "DEGRADED") {
          this.price = snap.estimate;
          this.reference = { price: snap.estimate, ts: this.feedAt };
          const t = Math.floor(this.feedAt / 1000) * 1000;
          const last = this.history[this.history.length - 1];
          if (!last || last.t < t) { this.history.push({ t, price: snap.estimate }); if (this.history.length > 900) this.history.shift(); }
        }
        this.priceFeed.ok(this.snapshot());
      };
      ws.onclose = () => {
        this.feedWs = null;
        if (!this.feedUrl) return;
        // Explicit error state — never falls back to synthetic prices.
        this.priceFeed.error("Live price feed disconnected — reconnecting. New positions and settlements are paused.");
        setTimeout(open, Math.min(10_000, 500 * 2 ** this.feedAttempt++));
      };
    };
    open();
  }

  /* ------------------------------------------------------------------- account */
  login() {
    this.loggedIn = true;
    this.account.ok(DEMO_USER);
    this.publishAll();
  }
  logout() {
    this.loggedIn = false;
    this.account.ok(null);
  }

  private balances(): Balances {
    return {
      free: this.free, positionCollateral: this.position?.collateral ?? 0n, pendingCollateral: this.pendingCollateral,
      wallet: this.wallet, depositedTotal: this.depositedTotal, fundingCap: this.params.fundingCapPerWallet,
      provenance: "CONFIRMED", block: this.block,
    };
  }

  async deposit(amount: bigint): Promise<TxProgress> {
    const room = this.params.fundingCapPerWallet - this.depositedTotal;
    if (amount <= 0n) throw new Error("Enter an amount above zero");
    if (amount > room) throw new Error(`Funding cap: you can deposit up to ${Number(room) / 1e6} more USDC`);
    if (amount > this.wallet) throw new Error("Not enough USDC in wallet");
    return this.runTx("Deposit USDC", () => {
      this.wallet -= amount; this.free += amount; this.depositedTotal += amount;
      this.record("DEPOSIT", "Deposited USDC", amount);
    });
  }

  async withdraw(amount: bigint): Promise<TxProgress> {
    if (amount <= 0n || amount > this.free) throw new Error("Amount exceeds free balance");
    return this.runTx("Withdraw USDC", () => {
      this.free -= amount; this.wallet += amount;
      this.record("WITHDRAW", "Withdrew USDC", amount);
    });
  }

  /* -------------------------------------------------------------------- quotes */
  private book() {
    return {
      reserve: this.reserve,
      reservedLiabilities: this.houseReserved(),
      netDirectionalNotional: this.position?.route === "HOUSE" ? dir(this.position.side) * this.position.notional : 0n,
      openHousePositions: this.position?.route === "HOUSE" ? 1 : 0,
    };
  }

  private houseReserved() {
    return (this.position?.route === "HOUSE" ? this.position.houseReservation : 0n) + this.fixtureReserved;
  }

  async quote(input: OrderDraft): Promise<Quote> {
    const t0 = performance.now();
    await delay(60 + Math.floor(this.rand() * 80));
    const snap = this.snapshot();
    const entry = snap.reference?.price ?? snap.estimate;
    const notional = notionalOf(input.collateral, input.leverage);
    const admission = admitHouseTrade(this.book(), input.side, input.collateral, input.leverage, this.params);
    const auto = autoExecution({ leverage: input.leverage, maintenanceBps: this.params.maintenanceBps, houseAvailable: admission.ok && this.scenario.houseCapacity !== "exhausted" });
    const draft: OrderDraft = { ...input, routes: auto.routes, matchWindowMs: auto.matchWindowMs, slippageBps: auto.slippageBps };
    const ex = exampleNetProfit(draft.collateral, draft.leverage, 0.05, this.params.profitFeeBps);
    const now = Date.now();
    return {
      id: `q-${now}`, draft, indicativeEntry: entry,
      priceLimit: slippageLimit(draft.side, entry, draft.slippageBps), notional,
      liquidationPrice: liquidationPrice(draft.side, entry, draft.leverage, this.params.maintenanceBps),
      feeBps: this.params.profitFeeBps, exampleMovePct: 0.05, exampleNetProfit: ex.net, exampleFee: ex.fee,
      capacity: {
        houseAvailable: admission.ok, houseReason: admission.ok ? undefined : admission.reason,
        houseReservationRequired: admission.reservation,
        houseCapacityRemaining: houseAvailableCapacity(this.book(), this.params),
        housePositionsRemaining: this.params.maxConcurrentHousePositions > 0 ? this.params.maxConcurrentHousePositions - this.book().openHousePositions : null,
        matchedPairsRemaining: this.params.maxConcurrentMatchedPairs - (this.pair ? 1 : 0),
        matchedOppositeWaiting: this.scenario.counterparty === "available" ? 1 : 0,
        provenance: "ESTIMATE",
      },
      configVersion: this.params.configVersion, createdAt: now, expiresAt: now + 10_000,
      latencyMs: Math.round(performance.now() - t0), executionSummary: auto.summary,
    };
  }

  /* ------------------------------------------------------------------- intents */
  private protocolState(): ProtocolState {
    return this.scenario.protocolState;
  }

  private setIntent(status: IntentStatus, patch: Partial<IntentState> = {}, note?: string) {
    if (!this.intent) return;
    const now = Date.now();
    this.intent = { ...this.intent, ...patch, status, updatedAt: now, timeline: [...this.intent.timeline, { status, at: now, note }] };
    this.intentFeed.ok(this.intent);
  }

  private releaseIntentCollateral() {
    this.free += this.pendingCollateral;
    this.pendingCollateral = 0n;
    this.publishBalances();
  }

  async submit(quote: Quote): Promise<IntentState> {
    const d = quote.draft;
    if (!this.loggedIn) throw new Error("Sign in first");
    if (this.position) throw new Error("You already have an open position (one per wallet in v1)");
    if (this.intent && ["SIGNING", "MATCHING", "SUBMITTED"].includes(this.intent.status)) throw new Error("A request is already pending");
    if (Date.now() > quote.expiresAt) throw new Error("Quote expired — review again");
    if (!d.routes.matched && !d.routes.houseFallback) throw new Error("Choose at least one route");
    if (d.collateral > this.free) throw new Error("Not enough free balance — deposit first");
    if (quote.configVersion !== this.params.configVersion) throw new Error("Protocol configuration changed — review again");

    const now = Date.now();
    const id = `intent-${++this.nonce}`;
    this.intent = {
      id, draft: d, status: "SIGNING", matchDeadline: now + (d.routes.matched ? d.matchWindowMs : 0),
      expiresAt: now + this.params.intentTtlMs, updatedAt: now, timeline: [{ status: "SIGNING", at: now }],
    };
    this.intentFeed.ok(this.intent);
    this.free -= d.collateral;
    this.pendingCollateral = d.collateral;
    this.publishBalances();

    await delay(450); // demo wallet signature
    if (this.intent?.id !== id || this.intent.status !== "SIGNING") return this.intent!;
    this.record("INTENT_SIGNED", `Signed ${d.side.toLowerCase()} request`, d.collateral);

    const state = this.protocolState();
    if (state !== "OPEN") {
      this.setIntent("REJECTED", { reason: `Protocol is ${state.replace("_", " ")} — new positions are not accepted` });
      this.releaseIntentCollateral();
      return this.intent!;
    }
    const q = this.snapshot().quality;
    if (q !== "OK" && q !== "DEGRADED") {
      this.setIntent("REJECTED", { reason: "Price check failed (stale or conflicting sources)" });
      this.releaseIntentCollateral();
      return this.intent!;
    }

    if (d.routes.matched) {
      this.setIntent("MATCHING", { matchDeadline: Date.now() + d.matchWindowMs });
      const matchAt = this.scenario.counterparty === "available" ? Math.min(1200 + Math.floor(this.rand() * 900), d.matchWindowMs - 200) : Infinity;
      if (Number.isFinite(matchAt)) {
        this.intentTimers.push(setTimeout(() => this.onMatched(id, quote), matchAt));
      } else {
        this.intentTimers.push(setTimeout(() => this.onMatchWindowEnded(id, quote), d.matchWindowMs));
      }
    } else {
      this.tryHouse(id, quote);
    }
    return this.intent!;
  }

  private onMatched(id: string, quote: Quote) {
    if (this.intent?.id !== id || this.intent.status !== "MATCHING") return;
    this.setIntent("SUBMITTED", { route: "MATCHED" }, "Matched with demo counterparty (fixture)");
    this.intentTimers.push(setTimeout(() => this.openPosition(id, quote, "MATCHED"), 650));
  }

  private onMatchWindowEnded(id: string, quote: Quote) {
    if (this.intent?.id !== id || this.intent.status !== "MATCHING") return;
    if (quote.draft.routes.houseFallback) this.tryHouse(id, quote, "No match in window — house fallback (authorised)");
    else {
      this.setIntent("EXPIRED", { reason: "No compatible match within your window. Nothing was opened." });
      this.record("INTENT_EXPIRED", "Request expired unmatched");
      this.releaseIntentCollateral();
    }
  }

  private tryHouse(id: string, quote: Quote, note?: string) {
    if (this.scenario.houseCapacity === "exhausted") this.fixtureReserved = houseAvailableCapacity({ ...this.book(), reservedLiabilities: this.houseReserved() - this.fixtureReserved }, this.params);
    else this.fixtureReserved = 0n;
    const d = quote.draft;
    const a = admitHouseTrade(this.book(), d.side, d.collateral, d.leverage, this.params);
    if (!a.ok) {
      // Busy, not impossible: wait in line until capacity frees up or the request expires (as the backend does).
      if (a.reason === "Not enough house reserve capacity" && Date.now() < (this.intent?.expiresAt ?? 0)) {
        if (this.intent?.status !== "QUEUED") {
          this.setIntent("QUEUED", { route: "HOUSE", queue: { position: 1, canFillGap: false } }, note ?? "House busy — waiting in line");
          // Demo fixture: an exhausted house frees up after a few seconds, as if another position closed.
          if (this.scenario.houseCapacity === "exhausted") this.intentTimers.push(setTimeout(() => { this.scenario = { ...this.scenario, houseCapacity: "normal" }; }, 4000));
        }
        this.intentTimers.push(setTimeout(() => { if (this.intent?.id === id && this.intent.status === "QUEUED") this.tryHouse(id, quote); }, 500));
        return;
      }
      this.setIntent("CAPACITY_UNAVAILABLE", { reason: `${a.reason}. Nothing was opened; your collateral is free again.` }, note);
      this.releaseIntentCollateral();
      this.publishHouse();
      return;
    }
    this.setIntent("SUBMITTED", { route: "HOUSE", queue: undefined }, note);
    this.intentTimers.push(setTimeout(() => this.openPosition(id, quote, "HOUSE"), 650));
  }

  private openPosition(id: string, quote: Quote, route: "MATCHED" | "HOUSE") {
    if (this.intent?.id !== id || this.intent.status !== "SUBMITTED") return;
    const d = quote.draft;
    const snap = this.snapshot();
    const entry = snap.reference?.price ?? snap.estimate;
    const beyond = d.side === "LONG" ? entry > quote.priceLimit : entry < quote.priceLimit;
    if (beyond) {
      this.setIntent("REJECTED", { reason: "Price moved beyond your tolerance before execution. Nothing was opened." });
      this.releaseIntentCollateral();
      return;
    }
    if (route === "HOUSE") {
      const a = admitHouseTrade(this.book(), d.side, d.collateral, d.leverage, this.params);
      if (!a.ok) {
        this.setIntent("CAPACITY_UNAVAILABLE", { reason: a.reason });
        this.releaseIntentCollateral();
        return;
      }
    }
    const txHash = pseudoHash(this.nonce, "open");
    const mk = (side: typeof d.side, pid: string): Position => ({
      id: pid, route, side, collateral: d.collateral, leverage: d.leverage, notional: notionalOf(d.collateral, d.leverage),
      entryPrice: entry, liquidationPrice: liquidationPrice(side, entry, d.leverage, this.params.maintenanceBps),
      houseReservation: route === "HOUSE" ? d.collateral * BigInt(this.params.houseReservationMultiple) : 0n,
      matchedMaxGrossWin: route === "MATCHED" ? d.collateral + this.params.matchedGapBackstop : 0n,
      feeBps: this.params.profitFeeBps, configVersion: this.params.configVersion, openedAt: Date.now(), openTx: txHash,
      counterpartyLabel: route === "MATCHED" ? "Demo counterparty (fixture)" : "House reserve",
      provenance: "CONFIRMED",
    });
    const pos = mk(d.side, `pos-${this.nonce}`);
    this.position = pos;
    if (route === "MATCHED") this.pair = { user: pos, counterparty: mk(d.side === "LONG" ? "SHORT" : "LONG", `pos-${this.nonce}-cp`) };
    this.pendingCollateral = 0n;
    this.setIntent("OPENED", { route, txHash, positionId: pos.id });
    this.record("POSITION_OPENED", `Opened ${d.side.toLowerCase()} · ${route === "HOUSE" ? "house" : "matched"}`, d.collateral, txHash);
    this.publishAll();
  }

  async cancel(id: string) {
    if (!this.intent || this.intent.id !== id) return;
    if (!["SIGNING", "MATCHING"].includes(this.intent.status)) throw new Error("Too late to cancel — already submitted");
    this.setIntent("CANCELLED", { reason: "Cancelled by you. Nothing was opened." });
    this.record("INTENT_CANCELLED", "Request cancelled");
    this.releaseIntentCollateral();
  }

  /* ----------------------------------------------------------------- settlement */
  async requestClose(positionId: string): Promise<TxProgress> {
    if (!this.position || this.position.id !== positionId) throw new Error("No such open position");
    if (this.closing) throw new Error("Close already in progress");
    if (this.scenario.protocolState === "ORACLE_HOLD" || this.snapshot().quality === "STALE") {
      throw new Error("Settlement needs a fresh verified price. Close is held until the oracle recovers.");
    }
    this.closing = true;
    this.publishPosition();
    return this.runTx("Close position", () => {
      this.closing = false;
      if (!this.position) return;
      this.settleCurrent(this.reference!.price, "USER", this.position.id);
    });
  }

  counterpartyClose() {
    if (!this.pair) return;
    this.settleCurrent(this.reference!.price, "USER", this.pair.counterparty.id);
  }

  private settleCurrent(exit: bigint, reason: CloseReason, initiatorId: string | null) {
    const p = this.position;
    if (!p) return;
    let s: Settlement;
    const txHash = pseudoHash(Date.now() % 1e9, "close");
    if (p.route === "MATCHED" && this.pair) {
      const [long, short] = p.side === "LONG" ? [p, this.pair.counterparty] : [this.pair.counterparty, p];
      const r = settleMatchedPair(long, short, exit, reason, initiatorId, Date.now());
      s = r.winner.positionId === p.id ? r.winner : r.loser;
      this.matchedFees += r.houseFee;
      this.reserve += r.houseFee + r.dust - r.houseGapPaid;
      this.gapPaid += r.houseGapPaid;
      recordHouseEarnings(this.g, r.houseFee + r.dust - r.houseGapPaid);
      this.pair = null;
    } else {
      s = settle(p, exit, reason, Date.now());
      if (s.netPnl < 0n) { this.collectedLosses += -s.netPnl; this.reserve += -s.netPnl; }
      else { this.netWinningPayouts += s.netPnl; this.reserve -= s.netPnl; }
      recordHouseEarnings(this.g, -s.netPnl);
      s = { ...s, rightsIssued: recordHouseResult(this.me, this.g, s.netPnl, this.params, this.reserve) };
      this.dimeSupply += s.rightsIssued;
    }
    s = { ...s, closeTx: txHash };
    this.free += s.returned;
    this.position = null;
    this.closing = false;
    const label = s.netPnl >= 0n ? "Settled · net gain" : "Settled · loss";
    this.record("POSITION_SETTLED", `${label} (${reasonText(s.reason)})`, s.netPnl, txHash);
    if (s.rightsIssued > 0n) this.record("RIGHTS_ISSUED", "Pending rights issued (activate next epoch)", s.rightsIssued);
    this.settled.emit(s);
    this.publishAll();
  }

  private runKeepers() {
    const p = this.position;
    if (!p || !this.reference || this.closing) return;
    if (this.scenario.protocolState === "ORACLE_HOLD" || this.snapshot().quality === "STALE") return;
    const mark = this.reference.price;
    if (isLiquidatable(p, mark)) return this.settleCurrent(mark, "LIQUIDATION", null);
    if (this.pair && isLiquidatable(this.pair.counterparty, mark)) return this.settleCurrent(mark, "LIQUIDATION", null);
    const prot = protectionCheck(p, mark, this.params);
    if (prot.triggered) {
      const cap = houseAvailableCapacity(this.book(), this.params);
      if (cap >= prot.extension) {
        this.position = { ...p, houseReservation: p.houseReservation + prot.extension };
        this.publishHouse();
      } else this.settleCurrent(mark, "RESERVE_PROTECTION", null);
    }
  }

  /* ---------------------------------------------------------------------- rights */
  advanceEpoch() {
    const f = computeFunding(this.g, this.reserve, this.houseReserved(), this.params);
    const funded = applyFunding(this.g, f);
    if (funded > 0n) {
      this.reserve -= funded;
      this.fundedUnclaimed += funded;
      this.record("DISTRIBUTION_FUNDED", `Epoch ${this.g.epoch} distribution funded`, funded);
    } else {
      this.record("DISTRIBUTION_FUNDED", `Epoch ${this.g.epoch}: nothing funded (${f.limitedBy.replaceAll("_", " ").toLowerCase()})`, 0n);
    }
    const hadPending = this.me.pendingEpoch === this.g.epoch + 1 ? this.me.pending : 0n;
    advanceEpoch(this.g);
    for (const u of this.fixtureUsers.values()) activateIfDue(u, this.g);
    if (hadPending > 0n) { activateIfDue(this.me, this.g); this.record("RIGHTS_ACTIVATED", "Your pending rights activated", hadPending); }
    this.publishAll();
  }

  async stake(amount: bigint): Promise<TxProgress> {
    if (amount <= 0n || amount > this.dimeWallet) throw new Error("Not enough DIME in wallet");
    if (this.me.active + this.me.pending + amount < this.params.minStake) {
      throw new Error(`Minimum stake is ${Number(this.params.minStake) / 1e18} DIME`);
    }
    return this.runTx("Stake DIME", () => {
      this.dimeWallet -= amount;
      stakeDime(this.me, this.g, amount);
      this.record("RIGHTS_ISSUED", "Staked DIME (active next epoch)", amount);
    });
  }

  async unstake(amount: bigint): Promise<TxProgress> {
    const staked = this.me.pending + effectiveActive(this.me, this.g);
    if (amount <= 0n || amount > staked) throw new Error("Not enough staked DIME");
    return this.runTx("Unstake DIME", () => {
      unstakeDime(this.me, this.g, amount);
      this.dimeWallet += amount;
      this.record("RIGHTS_ISSUED", "Unstaked DIME to wallet", amount);
    });
  }

  async claim(): Promise<TxProgress> {
    const amt = claimable(this.me, this.g);
    if (amt === 0n) throw new Error("Nothing to claim");
    return this.runTx("Claim distribution", () => {
      const got = claim(this.me, this.g);
      this.fundedUnclaimed -= got;
      this.free += got;
      this.record("CLAIM", "Claimed distribution USDC", got);
    });
  }

  /** Scenario lab: a fixture wallet's house trade settles with this net result (labelled in history). */
  fixtureHouseResult(net: bigint) {
    const k = "D";
    if (!this.fixtureUsers.has(k)) this.fixtureUsers.set(k, newUserRights());
    if (net < 0n) { this.collectedLosses += -net; this.reserve += -net; } else { this.netWinningPayouts += net; this.reserve -= net; }
    recordHouseEarnings(this.g, -net);
    this.dimeSupply += recordHouseResult(this.fixtureUsers.get(k)!, this.g, net, this.params, this.reserve);
    this.record("STATE_CHANGE", `Fixture wallet house trade settled (${net < 0n ? "loss" : "gain"}) — demo only`, net);
    this.publishAll();
  }

  /** Scenario lab: settle a $amount house LOSS for the signed-in demo user (from free balance) to demo DIME issuance. */
  demoUserHouseLoss(amount: bigint) {
    if (!this.loggedIn) throw new Error("Sign in first");
    if (this.free < amount) throw new Error("Deposit first — the loss comes from your free balance");
    this.free -= amount;
    this.collectedLosses += amount;
    this.reserve += amount;
    recordHouseEarnings(this.g, amount);
    const issued = recordHouseResult(this.me, this.g, -amount, this.params, this.reserve);
    this.dimeSupply += issued;
    this.record("POSITION_SETTLED", "Demo: house loss (scenario lab)", -amount);
    if (issued > 0n) this.record("RIGHTS_ISSUED", "DIME issued and auto-staked (active next epoch)", issued);
    this.publishAll();
  }

  /** Fixture "prior activity" by other demo wallets, replayed through the real ledger maths. */
  private replayFixtures() {
    const u = (k: string) => { if (!this.fixtureUsers.has(k)) this.fixtureUsers.set(k, newUserRights()); return this.fixtureUsers.get(k)!; };
    const houseResult = (k: string, net: number) => {
      const n = usd(net);
      if (n < 0n) { this.collectedLosses += -n; this.reserve += -n; } else { this.netWinningPayouts += n; this.reserve -= n; }
      recordHouseEarnings(this.g, -n);
      this.dimeSupply += recordHouseResult(u(k), this.g, n, this.params, this.reserve);
    };
    const fund = () => {
      const f = computeFunding(this.g, this.reserve, 0n, this.params);
      const x = applyFunding(this.g, f);
      this.reserve -= x; this.fundedUnclaimed += x;
      advanceEpoch(this.g);
      for (const x of this.fixtureUsers.values()) activateIfDue(x, this.g);
    };
    houseResult("A", -1.0); houseResult("B", -0.6); houseResult("C", 0.3);
    fund();
    houseResult("A", -0.5); houseResult("C", -0.2);
    this.matchedFees += usd(0.03); this.reserve += usd(0.03); recordHouseEarnings(this.g, usd(0.03));
    fund();
    const a = u("A"); const got = claim(a, this.g); this.fundedUnclaimed -= got;
    houseResult("B", -0.3); // pending for next epoch
  }

  /* -------------------------------------------------------------------- publish */
  private publishBalances() { if (this.loggedIn) this.balancesFeed.ok(this.balances()); }
  private publishPosition() { this.positionFeed.ok(this.position); }

  private publishHouse() {
    const p = this.position;
    let owed = 0n;
    if (p?.route === "HOUSE" && this.reference) {
      const g = cappedGrossPnl(p, this.reference.price).gross;
      owed = max(0n, g - (g > 0n ? (g * BigInt(p.feeBps) + BPS - 1n) / BPS : 0n));
    }
    const book = this.book();
    this.houseFeed.ok({
      reserve: this.reserve, reservedLiabilities: book.reservedLiabilities, unrealisedOwed: owed,
      availableCapacity: houseAvailableCapacity(book, this.params),
      matchedCollateralLocked: this.pair ? this.pair.user.collateral * 2n : 0n,
      matchedBackstopReserved: this.pair ? this.params.matchedGapBackstop : 0n,
      fundedUnclaimed: this.fundedUnclaimed, unfundedLiabilities: 0n,
      collectedLosses: this.collectedLosses, netWinningPayouts: this.netWinningPayouts, matchedFees: this.matchedFees,
      distributionsFunded: this.g.fundedTotal, distributionsClaimed: this.g.claimedTotal,
      netDirectionalNotional: book.netDirectionalNotional,
      houseLongNotional: p?.route === "HOUSE" && p.side === "LONG" ? p.notional : 0n,
      houseShortNotional: p?.route === "HOUSE" && p.side === "SHORT" ? p.notional : 0n,
      matchedNotionalPerSide: this.pair ? this.pair.user.notional : 0n,
      openHousePositions: book.openHousePositions,
      openMatchedPairs: this.pair ? 1 : 0, state: this.scenario.protocolState, epoch: this.g.epoch,
      epochEndsAt: 0, provenance: "CONFIRMED", block: this.block,
    });
  }

  private publishRights() {
    const pendingNext = this.g.pendingByEpoch.get(this.g.epoch + 1) ?? 0n;
    const mine = effectiveActive(this.me, this.g);
    const myNext = this.me.pendingEpoch === this.g.epoch + 1 ? this.me.pending : 0n;
    const totalNext = this.g.totalActive + pendingNext;
    const nextBps = totalNext === 0n ? 0 : Number(((mine + myNext) * BPS) / totalNext);
    this.rightsFeed.ok({
      pending: this.me.pendingEpoch !== null && this.me.pendingEpoch > this.g.epoch ? this.me.pending : 0n,
      pendingActivatesEpoch: this.me.pendingEpoch !== null && this.me.pendingEpoch > this.g.epoch ? this.me.pendingEpoch : null,
      active: mine, totalActive: this.g.totalActive, totalPendingNextEpoch: pendingNext,
      participationBps: participationBps(this.me, this.g), participationNextEpochBps: nextBps,
      claimable: claimable(this.me, this.g), claimed: this.me.claimed,
      netLossHighWater: this.me.netLossHighWater, cumulativeNetLoss: this.me.cumulativeNetLoss,
      wallet: this.dimeWallet, emissionRateE18: emissionRate(this.params, this.reserve), totalSupply: this.dimeSupply,
      transfersEnabled: false, transfersAt: null, estimatedPool: computeFunding(this.g, this.reserve, this.houseReserved(), this.params).funded || this.estimatedPool(),
      provenance: "CONFIRMED",
    });
  }

  /** If the epoch closed now: min(share × new earnings, surplus), ignoring the no-active-rights case. */
  private estimatedPool(): bigint {
    const eligible = this.g.houseCumulativeEarnings - this.g.earningsHighWater;
    if (eligible <= 0n) return 0n;
    const target = (eligible * BigInt(this.params.distributionShareBps)) / 10_000n;
    const needed = this.houseReserved() + this.params.distributionReserveFloor;
    const surplus = this.reserve > needed ? this.reserve - needed : 0n;
    return target < surplus ? target : surplus;
  }

  private publishIndexer() {
    this.indexerFeed.ok({
      connected: true, indexedBlock: this.block - 1n, indexedHash: pseudoHash(Number(this.block - 1n), "blk"),
      chainHead: this.block, lagBlocks: 1, lagMs: INDEX_DELAY_MS,
    });
  }

  private publishAll() {
    this.publishPrice();
    this.publishBalances();
    this.publishPosition();
    this.publishHouse();
    this.publishRights();
    this.historyFeed.ok([...this.indexed]);
    this.publishIndexer();
  }

  /* ---------------------------------------------------------------- tx + index */
  private record(kind: ActivityKind, title: string, amount?: bigint, txHash?: Hash) {
    const item: ActivityItem = {
      id: `ev-${this.chainEvents.length + 1}`, kind, at: Date.now(), title, amount,
      txHash: txHash ?? pseudoHash(this.chainEvents.length, kind), block: this.block, provenance: "INDEXED",
    };
    this.chainEvents.push(item);
    setTimeout(() => {
      this.indexed = [item, ...this.indexed].slice(0, 200);
      this.historyFeed.ok([...this.indexed]);
    }, INDEX_DELAY_MS);
  }

  private async runTx(label: string, effect: () => void): Promise<TxProgress> {
    const id = `tx-${++this.nonce}`;
    const now = Date.now();
    const t: TxProgress = { id, label, stage: "SUBMITTED", startedAt: now, updatedAt: now, txHash: pseudoHash(this.nonce, label) };
    const upd = (patch: Partial<TxProgress>) => {
      const i = this.txList.findIndex((x) => x.id === id);
      const next = { ...this.txList[i], ...patch, updatedAt: Date.now() };
      this.txList = [...this.txList.slice(0, i), next, ...this.txList.slice(i + 1)];
      this.txs.emit(this.txList);
      return next;
    };
    this.txList = [t, ...this.txList].slice(0, 12);
    this.txs.emit(this.txList);
    await delay(500);
    effect();
    this.publishAll();
    upd({ stage: "CONFIRMED" });
    setTimeout(() => upd({ stage: "INDEXED" }), INDEX_DELAY_MS);
    return this.txList.find((x) => x.id === id)!;
  }

  setScenario(patch: Partial<DemoScenario>) {
    this.scenario = { ...this.scenario, ...patch };
    if (patch.houseCapacity === "normal") this.fixtureReserved = 0n;
    if (patch.houseCapacity === "exhausted") this.fixtureReserved = houseAvailableCapacity({ ...this.book(), reservedLiabilities: this.houseReserved() - this.fixtureReserved }, this.params);
    if (patch.protocolState) this.record("STATE_CHANGE", `Protocol state → ${patch.protocolState}`);
    this.scenarioChanged.emit(this.scenario);
    this.publishAll();
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
