"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DemoScenario, Feed } from "@/adapters/types";
import type { ProtocolParams } from "@/config/protocol";
import type {
  Account, ActivityItem, Balances, HousePoint, HouseSnapshot, IndexerStatus, IntentState, Position, PricePoint, PriceSnapshot,
  RightsSnapshot, Settlement, TxProgress,
} from "@/domain/types";
import { count, record } from "./metrics";
import { useFeed, useServices } from "./services";

export interface AppState {
  account: Feed<Account | null>;
  balances: Feed<Balances>;
  price: Feed<PriceSnapshot>;
  params: Feed<ProtocolParams>;
  intent: Feed<IntentState | null>;
  position: Feed<Position | null>;
  house: Feed<HouseSnapshot>;
  rights: Feed<RightsSnapshot>;
  history: Feed<ActivityItem[]>;
  indexer: Feed<IndexerStatus>;
  txs: TxProgress[];
  series: PricePoint[];
  /** House state sampled once per second since this page opened (no back-fill). */
  houseSeries: HousePoint[];
  lastSettlement: Settlement | null;
  dismissSettlement(): void;
  scenario: DemoScenario | null;
}

const Ctx = createContext<AppState | null>(null);
export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppStateProvider missing");
  return v;
}

/** Single subscription point for the whole UI, so pages don't duplicate streams. */
export function AppStateProvider({ children }: { children: ReactNode }) {
  const s = useServices();
  const account = useFeed(s.wallet.subscribe, [s]);
  const addr = account.status === "ok" ? account.value?.address ?? null : null;

  const balances = useFeed(s.account.subscribeBalances, [s, addr]);
  const price = useFeed(s.market.subscribePrice, [s]);
  const params = useFeed(s.config.subscribe, [s]);
  const intent = useFeed(s.intents.subscribe, [s, addr]);
  const position = useFeed(s.positions.subscribe, [s, addr]);
  const house = useFeed(s.house.subscribe, [s]);
  const rights = useFeed(s.rights.subscribe, [s, addr]);
  const history = useFeed(s.history.subscribe, [s, addr]);
  const indexer = useFeed(s.history.subscribeIndexer, [s]);

  const [txs, setTxs] = useState<TxProgress[]>([]);
  useEffect(() => s.tx.subscribe(setTxs), [s]);

  const [scenario, setScenario] = useState<DemoScenario | null>(null);
  useEffect(() => s.demo?.subscribe(setScenario), [s]);

  const [lastSettlement, setLast] = useState<Settlement | null>(null);
  const closeStarted = useRef<number | null>(null);
  useEffect(() => s.positions.onSettled((x) => {
    setLast(x);
    if (closeStarted.current) record("closeToSettledMs", Date.now() - closeStarted.current);
    closeStarted.current = null;
  }), [s, addr]);
  useEffect(() => {
    const open = txs.find((t) => t.label === "Close position" && t.stage === "SUBMITTED");
    if (open && closeStarted.current === null) closeStarted.current = open.startedAt;
  }, [txs]);

  // Chart series: seed from history, then append indicative ticks (estimate).
  const [series, setSeries] = useState<PricePoint[]>([]);
  useEffect(() => { s.market.history(600).then(setSeries).catch(() => setSeries([])); }, [s]);
  useEffect(() => {
    if (price.status !== "ok") return;
    const p = price.value;
    if (p.quality !== "OK") return; // never chart stale / conflicting / placeholder estimates
    setSeries((prev) => {
      const t = p.sources.length ? Math.max(...p.sources.map((x) => x.ts)) : p.receivedAt;
      if (prev.length && prev[prev.length - 1].t >= t) return prev;
      const next = [...prev, { t, price: p.estimate }];
      return next.length > 900 ? next.slice(-900) : next;
    });
  }, [price]);

  const [houseSeries, setHouseSeries] = useState<HousePoint[]>([]);
  useEffect(() => {
    if (house.status !== "ok") return;
    const h = house.value;
    const t = Math.floor(Date.now() / 1000) * 1000;
    const pt: HousePoint = { t, reserve: h.reserve, available: h.availableCapacity, pnl: h.collectedLosses + h.matchedFees - h.netWinningPayouts };
    setHouseSeries((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.t >= t) return prev;
      const next = [...prev, pt];
      return next.length > 3600 ? next.slice(-3600) : next;
    });
  }, [house]);

  // Intent outcome + timing metrics, derived from observed timelines.
  const seenTerminal = useRef(new Set<string>());
  useEffect(() => {
    if (intent.status !== "ok" || !intent.value) return;
    const it = intent.value;
    if (!["OPENED", "EXPIRED", "CAPACITY_UNAVAILABLE", "REJECTED", "CANCELLED"].includes(it.status)) return;
    if (seenTerminal.current.has(it.id)) return;
    seenTerminal.current.add(it.id);
    const at = (st: string) => it.timeline.find((x) => x.status === st)?.at;
    const matching = at("MATCHING");
    const submitted = at("SUBMITTED");
    const signing = at("SIGNING");
    if (matching) record("matchWaitMs", (submitted ?? it.updatedAt) - matching);
    if (it.status === "OPENED" && signing) record("submitToOpenMs", it.updatedAt - signing);
    if (it.status === "OPENED") count(it.route === "MATCHED" ? "matched" : "houseFallback");
    if (it.status === "EXPIRED") count("expired");
    if (it.status === "CAPACITY_UNAVAILABLE") count("capacityUnavailable");
    if (it.status === "CANCELLED") count("cancelled");
    if (it.status === "REJECTED") count(/price/i.test(it.reason ?? "") ? "stalePriceRejected" : "rejected");
  }, [intent]);

  const seenEvents = useRef(new Set<string>());
  useEffect(() => {
    if (history.status !== "ok") return;
    const first = seenEvents.current.size === 0;
    for (const e of history.value) {
      if (seenEvents.current.has(e.id)) continue;
      seenEvents.current.add(e.id);
      if (!first) record("eventToScreenMs", Date.now() - e.at);
    }
  }, [history]);

  const value = useMemo<AppState>(() => ({
    account, balances, price, params, intent, position, house, rights, history, indexer, txs, series, houseSeries,
    lastSettlement, dismissSettlement: () => setLast(null), scenario,
  }), [account, balances, price, params, intent, position, house, rights, history, indexer, txs, series, houseSeries, lastSettlement, scenario]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
