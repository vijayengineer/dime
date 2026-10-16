/**
 * LIVE adapters. Wire formats are specified in docs/API.md; contract calls follow
 * contracts/src/interfaces/IChalk.sol. Not yet exercised against deployed services —
 * see docs/STATUS.md. Every failure is surfaced as a Feed error or thrown
 * ServiceError; nothing here falls back to demo data.
 */
import { createPublicClient, defineChain, http, type PublicClient, type WalletClient } from "viem";
import { defaultParams, MARKET, type ProtocolParams } from "@/config/protocol";
import { BTC_MARKET_ID, CLOSE_REQUEST_TYPES, orderIntentTypedData, randomNonce, routeMask, type Eip712Domain } from "@/domain/eip712";
import { liquidationPrice, notionalOf } from "@/domain/math";
import type {
  Account, ActivityItem, Address, Balances, Hash, HouseSnapshot, IndexerStatus, IntentState, OrderDraft,
  OrderIntentMessage, Position, PricePoint, PriceSnapshot, ProtocolState, Quote, RightsSnapshot, Settlement, TxProgress,
} from "@/domain/types";
import { Emitter, FeedHub } from "../feed";
import { decodePriceWire } from "../priceWire";
import { ServiceError, type AccessStatus, type Services } from "../types";
import { chalkAbi, dimeTokenAbi, erc20Abi } from "./abi";
import { termsMessage } from "@shared/terms";
import type { LiveEnv } from "./env";

export interface WalletBridge {
  account: FeedHub<Account | null>;
  login(): Promise<void>;
  logout(): Promise<void>;
  getWalletClient(): Promise<WalletClient>;
  /** Privy access token, sent as Bearer to the API. Verified server-side. */
  getAccessToken(): Promise<string | null>;
}

const STATES: ProtocolState[] = ["OPEN", "CLOSE_ONLY", "ORACLE_HOLD", "WIND_DOWN", "INSOLVENT"];
const big = (v: unknown) => BigInt(v as string);

function poll(fn: () => Promise<void>, ms: number): () => void {
  let stopped = false;
  let t: ReturnType<typeof setTimeout>;
  const run = async () => { try { await fn(); } finally { if (!stopped) t = setTimeout(run, ms); } };
  run();
  return () => { stopped = true; clearTimeout(t); };
}

export function createLiveServices(env: LiveEnv, wallet: WalletBridge): Services {
  const chain = defineChain({
    id: env.chainId, name: env.chainId === 143 ? "Monad" : "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [env.rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(env.rpcUrl) }) as PublicClient;
  const vault = { address: env.vault, abi: chalkAbi } as const;
  const me = () => (wallet.account.value.status === "ok" ? wallet.account.value.value : null);

  /* ------------------------------------------------------------------ http */
  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await wallet.getAccessToken();
    let res: Response;
    try {
      res = await fetch(`${env.apiUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
      });
    } catch (e) {
      throw new ServiceError("api", `unreachable (${(e as Error).message})`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ServiceError("api", body?.error?.message ?? `HTTP ${res.status}`, res.status >= 500);
    return body as T;
  }
  const jsonBig = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

  /* ---------------------------------------------------------------- stream */
  type Msg = { channel: string; data: unknown };
  const streamListeners = new Map<string, Set<(d: unknown) => void>>();
  const streamStatus = new FeedHub<boolean>();
  let ws: WebSocket | null = null;
  function ensureStream() {
    if (ws || typeof window === "undefined") return;
    ws = new WebSocket(env.streamUrl);
    ws.onopen = async () => {
      streamStatus.ok(true);
      // Subscribe first: public channels (price) must not depend on a session token.
      for (const ch of streamListeners.keys()) ws?.send(JSON.stringify({ op: "subscribe", channel: ch }));
      try {
        const token = await wallet.getAccessToken();
        if (token) ws?.send(JSON.stringify({ op: "auth", token }));
      } catch { /* signed out or session unavailable: public channels still work */ }
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string) as Msg;
      streamListeners.get(m.channel)?.forEach((l) => l(m.data));
    };
    ws.onclose = () => { ws = null; streamStatus.error("stream disconnected"); setTimeout(ensureStream, 2000); };
  }
  function onChannel(channel: string, cb: (d: unknown) => void) {
    // The API lowercases wallet channels (intents:/settlements:/tx:), so key listeners the same way.
    if (!channel.startsWith("price:")) channel = channel.toLowerCase();
    ensureStream();
    if (!streamListeners.has(channel)) {
      streamListeners.set(channel, new Set());
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "subscribe", channel }));
    }
    streamListeners.get(channel)!.add(cb);
    return () => { streamListeners.get(channel)?.delete(cb); };
  }

  /* ---------------------------------------------------------------- config */
  const configHub = new FeedHub<ProtocolParams>();
  let params: ProtocolParams | null = null;
  let domain: Eip712Domain | null = null;
  const loadConfig = async () => {
    try {
      const [cfg, token, dec, d] = await Promise.all([
        pub.readContract({ ...vault, functionName: "activeConfig" }),
        pub.readContract({ ...vault, functionName: "collateralToken" }),
        pub.readContract({ address: env.usdc, abi: erc20Abi, functionName: "decimals" }),
        pub.readContract({ ...vault, functionName: "eip712Domain" }),
      ]);
      if (token.toLowerCase() !== env.usdc.toLowerCase()) throw new Error(`vault collateral ${token} ≠ configured USDC ${env.usdc}`);
      if (dec !== env.usdcDecimals) throw new Error(`USDC decimals on-chain ${dec} ≠ configured ${env.usdcDecimals}`);
      if (Number(d[3]) !== env.chainId) throw new Error("EIP-712 domain chainId mismatch");
      domain = { name: d[1], version: d[2], chainId: env.chainId, verifyingContract: d[4] as Address };
      params = {
        ...defaultParams, configVersion: cfg.version, collateralDecimals: dec,
        fundingCapPerWallet: cfg.fundingCapPerWallet, minMargin: cfg.minCollateral, maxMargin: cfg.maxCollateral,
        maxLeverage: cfg.maxLeverage, profitFeeBps: cfg.profitFeeBps, maintenanceBps: cfg.maintenanceBps,
        houseReservationMultiple: cfg.houseReservationMultiple, protectionTriggerBps: cfg.protectionTriggerBps,
        houseMaxUtilisationBps: cfg.houseMaxUtilisationBps, houseMaxNetNotionalMultiple: cfg.houseMaxNetNotionalMultiple,
        maxConcurrentHousePositions: cfg.maxConcurrentHousePositions, maxConcurrentMatchedPairs: cfg.maxConcurrentMatchedPairs,
        matchedGapBackstop: cfg.matchedGapBackstop, dimePerUsdE18: cfg.dimePerUsdE18, emissionDecayTvl: cfg.emissionDecayTvl, maxMintPerEpoch: cfg.maxMintPerEpoch, minStake: cfg.minStake,
        distributionShareBps: cfg.distributionShareBps, distributionReserveFloor: cfg.distributionReserveFloor,
        epochSeconds: Number(cfg.epochSeconds), maxPriceAgeMs: cfg.maxPriceAgeMs,
        emissionCurve: env.emissionCurve, houseQueue: env.houseQueue,
      };
      configHub.ok(params);
    } catch (e) {
      params = null;
      configHub.error(`Contract configuration check failed: ${(e as Error).message}`);
    }
  };

  /* -------------------------------------------------------------------- tx */
  let txList: TxProgress[] = [];
  const txEmitter = new Emitter<TxProgress[]>();
  const txUpdate = (t: TxProgress) => {
    txList = [t, ...txList.filter((x) => x.id !== t.id)].slice(0, 12);
    txEmitter.emit(txList);
    return t;
  };
  async function sendTx(label: string, send: (w: WalletClient, account: Address) => Promise<Hash>): Promise<TxProgress> {
    const acct = me();
    if (!acct) throw new ServiceError("wallet", "not signed in", false);
    const id = `tx-${Date.now()}`;
    const startedAt = Date.now();
    let t = txUpdate({ id, label, stage: "SIGN", startedAt, updatedAt: startedAt });
    try {
      const w = await wallet.getWalletClient();
      const hash = await send(w, acct.address);
      t = txUpdate({ ...t, stage: "SUBMITTED", txHash: hash, updatedAt: Date.now() });
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("reverted");
      return txUpdate({ ...t, stage: "CONFIRMED", updatedAt: Date.now() });
    } catch (e) {
      txUpdate({ ...t, stage: "FAILED", error: (e as Error).message, updatedAt: Date.now() });
      throw e;
    }
  }

  /* ------------------------------------------------------------- positions */
  const decodePosition = (p: {
    id: Hash; user: Address; route: number; side: number; collateral: bigint; leverage: number; entryPrice: bigint;
    liquidationPrice: bigint; houseReservation: bigint; maxGrossWin: bigint; configVersion: number; openedAtMs: bigint; feeBps: number;
  }): Position | null =>
    p.collateral === 0n ? null : {
      id: p.id, route: p.route === 0 ? "MATCHED" : "HOUSE", side: p.side === 0 ? "LONG" : "SHORT",
      collateral: p.collateral, leverage: p.leverage, notional: notionalOf(p.collateral, p.leverage),
      entryPrice: p.entryPrice, liquidationPrice: p.liquidationPrice, houseReservation: p.houseReservation,
      matchedMaxGrossWin: p.maxGrossWin, feeBps: p.feeBps, configVersion: p.configVersion,
      openedAt: Number(p.openedAtMs), provenance: "CONFIRMED",
    };

  const decodePrice = (d: Record<string, unknown>): PriceSnapshot => decodePriceWire(d as Record<string, any>);

  const decodeIntent = (d: Record<string, unknown>): IntentState => ({
    ...(d as unknown as IntentState),
    draft: { ...(d.draft as OrderDraft), collateral: big((d.draft as Record<string, unknown>).collateral) },
  });

  /* ---------------------------------------------------------------- services */
  const services: Services = {
    mode: "live",
    chain: { id: env.chainId, name: chain.name, explorer: env.explorerUrl },

    wallet: {
      kind: "privy",
      subscribe: (cb) => wallet.account.subscribe(cb),
      login: () => wallet.login(),
      logout: () => wallet.logout(),
    },

    config: { subscribe: (cb) => configHub.subscribe(cb, () => { poll(loadConfig, 30_000); }) },

    account: {
      subscribeBalances(cb) {
        const hub = new FeedHub<Balances>();
        const un = hub.subscribe(cb);
        const stop = poll(async () => {
          const a = me();
          if (!a) return;
          try {
            const [free, locked, deposited, walletBal, block] = await Promise.all([
              pub.readContract({ ...vault, functionName: "freeBalance", args: [a.address] }),
              pub.readContract({ ...vault, functionName: "lockedCollateral", args: [a.address] }),
              pub.readContract({ ...vault, functionName: "depositedTotal", args: [a.address] }),
              pub.readContract({ address: env.usdc, abi: erc20Abi, functionName: "balanceOf", args: [a.address] }),
              pub.getBlockNumber(),
            ]);
            hub.ok({
              free, positionCollateral: locked, pendingCollateral: 0n, wallet: walletBal, depositedTotal: deposited,
              fundingCap: params?.fundingCapPerWallet ?? 0n, provenance: "CONFIRMED", block,
            });
          } catch (e) { hub.error(`balance read failed: ${(e as Error).message}`); }
        }, 2000);
        return () => { stop(); un(); };
      },
      async deposit(amount) {
        return sendTx("Deposit USDC", async (w, account) => {
          const allowance = await pub.readContract({ address: env.usdc, abi: erc20Abi, functionName: "allowance", args: [account, env.vault] });
          if (allowance < amount) {
            const h = await w.writeContract({ chain, account, address: env.usdc, abi: erc20Abi, functionName: "approve", args: [env.vault, amount] });
            await pub.waitForTransactionReceipt({ hash: h });
          }
          return w.writeContract({ chain, account, ...vault, functionName: "deposit", args: [amount] });
        });
      },
      async withdraw(amount) {
        return sendTx("Withdraw USDC", (w, account) => w.writeContract({ chain, account, ...vault, functionName: "withdraw", args: [amount] }));
      },
    },

    market: {
      subscribePrice(cb) {
        const hub = new FeedHub<PriceSnapshot>();
        const un = hub.subscribe(cb);
        const off = onChannel(`price:${MARKET}`, (d) => hub.ok(decodePrice(d as Record<string, unknown>)));
        const offStatus = streamStatus.subscribe((s) => { if (s.status === "error") hub.error(`price stream: ${s.error}`); });
        return () => { off(); offStatus(); un(); };
      },
      async history(limit) {
        const r = await api<{ points: { t: number; price: string }[] }>(`/v1/markets/${MARKET}/history?limit=${limit}`);
        return r.points.map((p): PricePoint => ({ t: p.t, price: BigInt(p.price) }));
      },
    },

    intents: {
      async quote(draft) {
        const t0 = performance.now();
        const r = await api<Record<string, unknown>>("/v1/quotes", { method: "POST", body: jsonBig({ market: MARKET, ...draft }) });
        const cap = r.capacity as Record<string, unknown>;
        // The backend auto-selects route, match window and tolerance; the signed intent uses them.
        const auto = r.auto as { routes: OrderDraft["routes"]; matchWindowMs: number; slippageBps: number; summary: string } | undefined;
        if (auto) draft = { ...draft, routes: auto.routes, matchWindowMs: auto.matchWindowMs, slippageBps: auto.slippageBps };
        const q: Quote = {
          executionSummary: auto?.summary,
          id: String(r.id), draft, indicativeEntry: big(r.indicativeEntry), priceLimit: big(r.priceLimit),
          notional: notionalOf(draft.collateral, draft.leverage),
          liquidationPrice: params ? liquidationPrice(draft.side, big(r.indicativeEntry), draft.leverage, params.maintenanceBps) : big(r.liquidationPrice),
          feeBps: Number(r.feeBps), exampleMovePct: Number(r.exampleMovePct), exampleNetProfit: big(r.exampleNetProfit), exampleFee: big(r.exampleFee),
          capacity: {
            houseAvailable: Boolean(cap.houseAvailable), houseReason: cap.houseReason as string | undefined,
            houseReservationRequired: big(cap.houseReservationRequired), houseCapacityRemaining: big(cap.houseCapacityRemaining),
            housePositionsRemaining: cap.housePositionsRemaining == null ? null : Number(cap.housePositionsRemaining),
            houseWouldWait: cap.houseWouldWait === undefined ? undefined : Boolean(cap.houseWouldWait),
            houseQueueLength: cap.houseQueueLength === undefined ? undefined : Number(cap.houseQueueLength),
            matchedPairsRemaining: Number(cap.matchedPairsRemaining),
            matchedOppositeWaiting: cap.matchedOppositeWaiting == null ? null : Number(cap.matchedOppositeWaiting), provenance: "ESTIMATE",
          },
          configVersion: Number(r.configVersion), createdAt: Date.now(), expiresAt: Number(r.expiresAt),
          latencyMs: Math.round(performance.now() - t0),
        };
        return q;
      },
      async submit(q) {
        const acct = me();
        if (!acct) throw new ServiceError("wallet", "not signed in", false);
        if (!params || !domain) throw new ServiceError("config", "contract configuration not verified", false);
        if (q.configVersion !== params.configVersion) throw new ServiceError("config", "configuration changed — review again", false);
        const now = Math.floor(Date.now() / 1000);
        const msg: OrderIntentMessage = {
          user: acct.address, market: BTC_MARKET_ID, side: q.draft.side === "LONG" ? 0 : 1,
          collateral: q.draft.collateral, leverage: q.draft.leverage, routeMask: routeMask(q.draft.routes),
          matchDeadline: BigInt(now + Math.ceil(q.draft.matchWindowMs / 1000)), priceLimit: q.priceLimit,
          configVersion: params.configVersion, expiry: BigInt(now + Math.ceil(params.intentTtlMs / 1000)), nonce: randomNonce(),
        };
        const w = await wallet.getWalletClient();
        const signature = await w.signTypedData({ account: acct.address, ...orderIntentTypedData(domain, msg) });
        const idempotencyKey = `${acct.address}:${msg.nonce}`;
        return decodeIntent(await api("/v1/intents", {
          method: "POST", headers: { "idempotency-key": idempotencyKey }, body: jsonBig({ quoteId: q.id, message: msg, signature, matchWindowMs: q.draft.matchWindowMs, slippageBps: q.draft.slippageBps }),
        }));
      },
      async cancel(id) {
        // The API requires the requesting wallet to sign the cancellation.
        const acct = me();
        if (!acct) throw new ServiceError("wallet", "not signed in", false);
        const w = await wallet.getWalletClient();
        const signature = await w.signMessage({ account: acct.address, message: `DIME cancel request ${id}` });
        await api(`/v1/intents/${id}/cancel`, { method: "POST", body: JSON.stringify({ signature }) });
      },
      subscribe(cb) {
        const hub = new FeedHub<IntentState | null>();
        hub.ok(null);
        const un = hub.subscribe(cb);
        const a = me();
        const off = a ? onChannel(`intents:${a.address}`, (d) => hub.ok(decodeIntent(d as Record<string, unknown>))) : () => {};
        return () => { off(); un(); };
      },
    },

    positions: {
      subscribe(cb) {
        const hub = new FeedHub<Position | null>();
        const un = hub.subscribe(cb);
        const stop = poll(async () => {
          const a = me();
          if (!a) return hub.ok(null);
          try { hub.ok(decodePosition(await pub.readContract({ ...vault, functionName: "positionOf", args: [a.address] }))); }
          catch (e) { hub.error(`position read failed: ${(e as Error).message}`); }
        }, 1000);
        return () => { stop(); un(); };
      },
      async requestClose(positionId) {
        const acct = me();
        if (!acct || !domain) throw new ServiceError("wallet", "not ready", false);
        const id = `close-${positionId}`;
        const t = txUpdate({ id, label: "Close position", stage: "SIGN", startedAt: Date.now(), updatedAt: Date.now() });
        const message = { user: acct.address, positionId: positionId as Hash, expiry: BigInt(Math.floor(Date.now() / 1000) + 30), nonce: randomNonce() };
        const w = await wallet.getWalletClient();
        const signature = await w.signTypedData({ account: acct.address, domain, types: CLOSE_REQUEST_TYPES, primaryType: "CloseRequest", message });
        const r = await api<{ txHash: Hash }>("/v1/close", { method: "POST", headers: { "idempotency-key": `${acct.address}:${message.nonce}` }, body: jsonBig({ message, signature }) });
        return txUpdate({ ...t, stage: "SUBMITTED", txHash: r.txHash, updatedAt: Date.now() });
      },
      onSettled(cb) {
        const a = me();
        return a ? onChannel(`settlements:${a.address}`, (d) => {
          const x = d as Record<string, unknown>;
          cb({
            ...(x as unknown as Settlement),
            collateral: big(x.collateral), entryPrice: big(x.entryPrice), exitPrice: big(x.exitPrice), grossPnl: big(x.grossPnl),
            fee: big(x.fee), netPnl: big(x.netPnl), returned: big(x.returned), rightsIssued: big(x.rightsIssued),
          });
        }) : () => {};
      },
    },

    house: {
      subscribe(cb) {
        const hub = new FeedHub<HouseSnapshot>();
        const un = hub.subscribe(cb);
        const stop = poll(async () => {
          try {
            const [s, st, ep, funded, claimed, block, startedAt] = await Promise.all([
              pub.readContract({ ...vault, functionName: "houseStats" }),
              pub.readContract({ ...vault, functionName: "protocolState" }),
              pub.readContract({ ...vault, functionName: "epoch" }),
              pub.readContract({ ...vault, functionName: "distributionsFunded" }),
              pub.readContract({ ...vault, functionName: "distributionsClaimed" }),
              pub.getBlockNumber(),
              pub.readContract({ ...vault, functionName: "epochStartedAt" }),
            ]);
            hub.ok({
              reserve: s.reserve, reservedLiabilities: s.reservedLiabilities, unrealisedOwed: 0n,
              availableCapacity: s.availableCapacity, matchedCollateralLocked: s.matchedCollateralLocked,
              matchedBackstopReserved: s.matchedBackstopReserved, fundedUnclaimed: s.fundedUnclaimed,
              unfundedLiabilities: s.unfundedLiabilities, collectedLosses: s.collectedLosses,
              netWinningPayouts: s.netWinningPayouts, matchedFees: s.matchedFees,
              distributionsFunded: funded, distributionsClaimed: claimed,
              netDirectionalNotional: s.netDirectionalNotional, houseLongNotional: s.houseLongNotional,
              houseShortNotional: s.houseShortNotional, matchedNotionalPerSide: s.matchedNotionalPerSide,
              openHousePositions: s.openHousePositions,
              openMatchedPairs: s.openMatchedPairs, state: STATES[st] ?? "INSOLVENT", epoch: Number(ep),
              epochEndsAt: params ? (Number(startedAt) + params.epochSeconds) * 1000 : 0, provenance: "CONFIRMED", block,
            });
          } catch (e) { hub.error(`house read failed: ${(e as Error).message}`); }
        }, 2000);
        return () => { stop(); un(); };
      },
    },

    rights: {
      subscribe(cb) {
        const hub = new FeedHub<RightsSnapshot>();
        const un = hub.subscribe(cb);
        const stop = poll(async () => {
          const a = me();
          if (!a) return;
          try {
            const ep = await pub.readContract({ ...vault, functionName: "epoch" });
            const dimeAddr = await pub.readContract({ ...vault, functionName: "dimeToken" });
            const dime = { address: dimeAddr, abi: dimeTokenAbi } as const;
            const [r, total, pendingNext, wallet, supply, transfers, rate, transfersAt] = await Promise.all([
              pub.readContract({ ...vault, functionName: "rightsOf", args: [a.address] }),
              pub.readContract({ ...vault, functionName: "totalActive" }),
              pub.readContract({ ...vault, functionName: "pendingForEpoch", args: [ep + 1n] }),
              pub.readContract({ ...dime, functionName: "balanceOf", args: [a.address] }),
              pub.readContract({ ...dime, functionName: "totalSupply" }),
              pub.readContract({ ...dime, functionName: "transfersEnabled" }),
              pub.readContract({ ...vault, functionName: "emissionRate" }),
              pub.readContract({ ...dime, functionName: "transfersAt" }),
            ]);
            const myNext = r.pendingEpoch === ep + 1n ? r.pending : 0n;
            hub.ok({
              pending: r.pending, pendingActivatesEpoch: r.pending > 0n ? Number(r.pendingEpoch) : null, active: r.active,
              totalActive: total, totalPendingNextEpoch: pendingNext,
              participationBps: total === 0n ? 0 : Number((r.active * 10_000n) / total),
              participationNextEpochBps: total + pendingNext === 0n ? 0 : Number(((r.active + myNext) * 10_000n) / (total + pendingNext)),
              claimable: r.claimable, claimed: r.claimed, netLossHighWater: r.netLossHighWater,
              cumulativeNetLoss: r.cumulativeNetLoss, wallet, emissionRateE18: rate, totalSupply: supply, transfersEnabled: transfers,
              transfersAt: transfersAt > 0n ? Number(transfersAt) * 1000 : null,
              estimatedPool: 0n, // server-side estimate not yet exposed; shown as "—"
              provenance: "CONFIRMED",
            });
          } catch (e) { hub.error(`rights read failed: ${(e as Error).message}`); }
        }, 3000);
        return () => { stop(); un(); };
      },
      async claim() {
        return sendTx("Claim distribution", (w, account) => w.writeContract({ chain, account, ...vault, functionName: "claim" }));
      },
      async stake(amount) {
        return sendTx("Stake DIME", async (w, account) => {
          const dimeAddr = await pub.readContract({ ...vault, functionName: "dimeToken" });
          const allowance = await pub.readContract({ address: dimeAddr, abi: dimeTokenAbi, functionName: "allowance", args: [account, env.vault] });
          if (allowance < amount) {
            const h = await w.writeContract({ chain, account, address: dimeAddr, abi: dimeTokenAbi, functionName: "approve", args: [env.vault, amount] });
            await pub.waitForTransactionReceipt({ hash: h });
          }
          return w.writeContract({ chain, account, ...vault, functionName: "stake", args: [amount] });
        });
      },
      async unstake(amount) {
        return sendTx("Unstake DIME", (w, account) => w.writeContract({ chain, account, ...vault, functionName: "unstake", args: [amount] }));
      },
    },

    history: {
      subscribe(cb) {
        const hub = new FeedHub<ActivityItem[]>();
        const un = hub.subscribe(cb);
        const stop = poll(async () => {
          const a = me();
          if (!a) return hub.ok([]);
          try {
            if (!env.envioUrl) {
              const r = await api<{ items: { id: string; kind: string; at: number; title: string; amount?: string; txHash: string; block: string }[] }>(`/v1/activity/${a.address}`);
              return hub.ok(r.items.map((x) => ({
                id: x.id, kind: x.kind as ActivityItem["kind"], at: x.at, title: x.title,
                amount: x.amount != null ? BigInt(x.amount) : undefined, txHash: x.txHash as Hash, block: BigInt(x.block), provenance: "INDEXED",
              })));
            }
            const r = await fetch(env.envioUrl, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ query: ACTIVITY_QUERY, variables: { user: a.address.toLowerCase() } }),
            });
            const j = await r.json();
            if (j.errors) throw new Error(j.errors[0]?.message);
            hub.ok((j.data.Activity as Record<string, string>[]).map((x) => ({
              id: x.id, kind: x.kind as ActivityItem["kind"], at: Number(x.timestamp) * 1000, title: x.title,
              amount: x.amount != null ? BigInt(x.amount) : undefined, txHash: x.txHash as Hash, block: BigInt(x.blockNumber),
              provenance: "INDEXED",
            })));
          } catch (e) { hub.error(`Envio query failed: ${(e as Error).message}`); }
        }, 5000);
        return () => { stop(); un(); };
      },
      subscribeIndexer(cb) {
        const hub = new FeedHub<IndexerStatus>();
        const un = hub.subscribe(cb);
        const stop = poll(async () => {
          try {
            if (!env.envioUrl) {
              const v = await api<{ indexedBlock: string | null; chainHead: string | null; lagBlocks: number | null }>("/v1/indexer");
              const indexed = v.indexedBlock ? BigInt(v.indexedBlock) : null;
              const blk = indexed != null ? await pub.getBlock({ blockNumber: indexed }) : null;
              const head = await pub.getBlock();
              return hub.ok({
                connected: indexed != null, indexedBlock: indexed, indexedHash: blk?.hash ?? null, chainHead: head.number,
                lagBlocks: indexed != null ? Number(head.number - indexed) : null,
                lagMs: blk ? Math.max(0, Number(head.timestamp - blk.timestamp) * 1000) : null,
              });
            }
            const [r, head] = await Promise.all([
              fetch(env.envioUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: INDEXER_QUERY }) }).then((x) => x.json()),
              pub.getBlock(),
            ]);
            const m = r.data.chain_metadata[0];
            const indexed = BigInt(m.latest_processed_block);
            const blk = await pub.getBlock({ blockNumber: indexed });
            hub.ok({
              connected: true, indexedBlock: indexed, indexedHash: blk.hash, chainHead: head.number,
              lagBlocks: Number(head.number - indexed), lagMs: Number(head.timestamp - blk.timestamp) * 1000,
            });
          } catch (e) { hub.error(`indexer status unavailable: ${(e as Error).message}`); }
        }, 6000);
        return () => { stop(); un(); };
      },
    },

    tx: { subscribe: (cb) => { cb(txList); return txEmitter.subscribe(cb); } },

    access: {
      status: (address) => api<AccessStatus>(`/v1/access/${address}`),
      async join(address, code) {
        const w = await wallet.getWalletClient();
        const signature = await w.signMessage({ account: address, message: termsMessage(address) });
        return api<AccessStatus>("/v1/access", { method: "POST", body: JSON.stringify({ address, signature, code }) });
      },
    },
  };
  return services;
}

const ACTIVITY_QUERY = `query Activity($user: String!) {
  Activity(where: { user: { _eq: $user } }, order_by: { timestamp: desc }, limit: 100) {
    id kind title amount txHash blockNumber timestamp
  }
}`;
const INDEXER_QUERY = `query { chain_metadata { chain_id latest_processed_block block_height } }`;
