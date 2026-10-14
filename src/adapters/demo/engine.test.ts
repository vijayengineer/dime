import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderDraft, Settlement } from "@/domain/types";
import { DemoEngine } from "./engine";

const usd = (n: number) => BigInt(Math.round(n * 1e6));
// Test-only: read the current value of an engine feed (assumes status "ok").
const val = <T,>(f: { value: unknown }) => (f.value as { value: T }).value;

async function flush(ms: number) { await vi.advanceTimersByTimeAsync(ms); }
/** Start an engine call, advance fake time past its internal delays, then await it. */
async function run<T>(p: Promise<T>, ms = 2000): Promise<T> { p.catch(() => {}); await flush(ms); return p; }

function draft(over: Partial<OrderDraft> = {}): OrderDraft {
  return { side: "SHORT", collateral: usd(0.1), leverage: 1000, routes: { matched: false, houseFallback: true }, matchWindowMs: 3000, slippageBps: 2, ...over };
}

describe("demo engine end-to-end", () => {
  let e: DemoEngine;
  beforeEach(() => { vi.useFakeTimers(); e = new DemoEngine(); e.login(); });
  afterEach(() => { e.stop(); vi.useRealTimers(); });

  it("house trade → liquidation → rights → activation → funded distribution → claim", async () => {
    e.setScenario({ counterparty: "none" }); // auto-execution: the house takes it straight away
    await run(e.deposit(usd(2)));
    expect(val<{ free: bigint }>(e.balancesFeed).free).toBe(usd(2));

    const reserveBefore = val<{ reserve: bigint }>(e.houseFeed).reserve;
    const q = await run(e.quote(draft()), 300);
    expect(q.draft.routes).toEqual({ matched: false, houseFallback: true }); // house-first, auto-selected
    await run(e.submit(q), 5000);
    expect(val<{ status: string }>(e.intentFeed).status).toBe("OPENED");
    expect(val<{ route: string } | null>(e.positionFeed)?.route).toBe("HOUSE");

    const settled: Settlement[] = [];
    e.settled.subscribe((s) => settled.push(s));
    e.priceShock(20); // short loses through liquidation
    expect(settled[0].reason).toBe("LIQUIDATION");
    expect(settled[0].returned).toBe(0n);
    expect(settled[0].rightsIssued).toBe(10n ** 16n); // 0.01 DIME for a $0.10 loss
    expect(val<{ reserve: bigint }>(e.houseFeed).reserve).toBe(reserveBefore + usd(0.1));

    const r1 = val<{ pending: bigint; active: bigint }>(e.rightsFeed);
    expect(r1.pending).toBe(10n ** 16n);
    expect(r1.active).toBe(0n);

    e.advanceEpoch(); // funds the epoch the loss happened in; user not yet active
    const r2 = val<{ active: bigint; claimable: bigint }>(e.rightsFeed);
    expect(r2.active).toBe(10n ** 16n);
    expect(r2.claimable).toBe(0n);

    e.fixtureHouseResult(-usd(0.5));
    e.advanceEpoch();
    const r3 = val<{ claimable: bigint; participationBps: number }>(e.rightsFeed);
    expect(r3.claimable).toBeGreaterThan(0n);

    const freeBefore = val<{ free: bigint }>(e.balancesFeed).free;
    await run(e.claim());
    expect(val<{ free: bigint }>(e.balancesFeed).free).toBe(freeBefore + r3.claimable);
    expect(val<{ claimable: bigint }>(e.rightsFeed).claimable).toBe(0n);
  });

  it("matched pair: counterparty close settles the user's side; fee goes to house", async () => {
    e.setScenario({ houseCapacity: "exhausted" }); // matching is the overflow path when the house is full
    await run(e.deposit(usd(2)));
    const q = await run(e.quote(draft({ side: "LONG", routes: { matched: true, houseFallback: false }, matchWindowMs: 5000 })), 300);
    await run(e.submit(q), 4000);
    expect(val<{ route: string } | null>(e.positionFeed)?.route).toBe("MATCHED");
    const settled: Settlement[] = [];
    e.settled.subscribe((s) => settled.push(s));
    e.counterpartyClose();
    expect(settled[0].reason).toBe("COUNTERPARTY");
    expect(val<unknown>(e.positionFeed)).toBeNull();
    expect(settled[0].rightsIssued).toBe(0n);
  });

  it("when the house is full, auto-execution is match-only and an unmatched request expires", async () => {
    e.setScenario({ counterparty: "none", houseCapacity: "exhausted" });
    await run(e.deposit(usd(1)));
    const q = await run(e.quote(draft()), 300);
    expect(q.draft.routes).toEqual({ matched: true, houseFallback: false });
    await run(e.submit(q), 9000);
    expect(val<{ status: string }>(e.intentFeed).status).toBe("EXPIRED");
    expect(val<{ free: bigint; pendingCollateral: bigint }>(e.balancesFeed)).toMatchObject({ free: usd(1), pendingCollateral: 0n });
    expect(val<unknown>(e.positionFeed)).toBeNull();
  });

  it("capacity that disappears during the window reports capacity unavailable", async () => {
    e.setScenario({ counterparty: "none" });
    await run(e.deposit(usd(1)));
    const q = await run(e.quote(draft()), 300);
    const p = e.submit(q);
    await flush(1000);
    e.setScenario({ houseCapacity: "exhausted" });
    await run(p, 5000);
    expect(val<{ status: string }>(e.intentFeed).status).toBe("CAPACITY_UNAVAILABLE");
    expect(val<unknown>(e.positionFeed)).toBeNull();
  });

  it("rejects new positions when not OPEN or when price is stale", async () => {
    await run(e.deposit(usd(1)));
    e.setScenario({ protocolState: "CLOSE_ONLY" });
    let q = await run(e.quote(draft()), 300);
    await run(e.submit(q), 1000);
    expect(val<{ status: string }>(e.intentFeed).status).toBe("REJECTED");
    e.setScenario({ protocolState: "OPEN", oracle: "stale" });
    await flush(5000);
    q = await run(e.quote(draft()), 300);
    q = { ...q, expiresAt: Date.now() + 10_000 };
    await run(e.submit(q), 1000);
    expect(val<{ status: string; reason: string }>(e.intentFeed).reason).toMatch(/stale/);
  });

  it("enforces the per-wallet funding cap", async () => {
    await run(e.deposit(usd(10)));
    await expect(e.deposit(usd(0.01))).rejects.toThrow(/cap/i);
  });
});
