import type { Services } from "../types";
import { DemoEngine } from "./engine";

/** Explicit demo mode. Every value originates from DemoEngine and is labelled DEMO in the UI. */
export function createDemoServices(): Services {
  const e = new DemoEngine();
  const feedUrl = process.env.NEXT_PUBLIC_PRICE_FEED_URL;
  if (typeof window !== "undefined") {
    if (feedUrl) e.attachFeed(feedUrl);
    e.start();
  }
  return {
    mode: "demo",
    chain: { id: 0, name: "Demo (no chain)", explorer: null },
    wallet: {
      kind: "demo",
      subscribe: (cb) => e.account.subscribe(cb),
      login: async () => e.login(),
      logout: async () => e.logout(),
    },
    account: {
      subscribeBalances: (cb) => e.balancesFeed.subscribe(cb),
      deposit: (a) => e.deposit(a),
      withdraw: (a) => e.withdraw(a),
    },
    market: {
      subscribePrice: (cb) => e.priceFeed.subscribe(cb),
      history: async (n) => e.priceHistory(n),
    },
    config: { subscribe: (cb) => e.configFeed.subscribe(cb) },
    intents: {
      quote: (d) => e.quote(d),
      submit: (q) => e.submit(q),
      cancel: (id) => e.cancel(id),
      subscribe: (cb) => e.intentFeed.subscribe(cb),
    },
    positions: {
      subscribe: (cb) => e.positionFeed.subscribe(cb),
      requestClose: (id) => e.requestClose(id),
      onSettled: (cb) => e.settled.subscribe(cb),
    },
    house: { subscribe: (cb) => e.houseFeed.subscribe(cb) },
    rights: { subscribe: (cb) => e.rightsFeed.subscribe(cb), claim: () => e.claim(), stake: (a) => e.stake(a), unstake: (a) => e.unstake(a) },
    history: {
      subscribe: (cb) => e.historyFeed.subscribe(cb),
      subscribeIndexer: (cb) => e.indexerFeed.subscribe(cb),
    },
    tx: { subscribe: (cb) => { cb([]); return e.txs.subscribe(cb); } },
    demo: {
      get scenario() { return e.scenario; },
      subscribe: (cb) => { cb(e.scenario); return e.scenarioChanged.subscribe(cb); },
      setScenario: (p) => e.setScenario(p),
      advanceEpoch: () => e.advanceEpoch(),
      counterpartyClose: () => e.counterpartyClose(),
      priceShock: (bps) => e.priceShock(bps),
      // From config (not connection state) so server and client render the same banner.
      liveFeed: !!feedUrl,
      fixtureHouseResult: (net) => e.fixtureHouseResult(net),
      demoUserHouseLoss: (a) => e.demoUserHouseLoss(a),
      reset: () => e.reset(),
    },
  };
}
