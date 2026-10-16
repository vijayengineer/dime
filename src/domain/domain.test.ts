import { describe, expect, it } from "vitest";
import { defaultParams as P, PRICE_SCALE } from "@/config/protocol";
import { ceilDiv, floorDiv, fmtAmount, formatUnits, parseUnits } from "./fixed";
import {
  admitHouseTrade, cappedGrossPnl, isLiquidatable, liquidationPrice, notionalOf, profitFee,
  rawGrossPnl, settle, settleMatchedPair,
} from "./math";
import {
  advanceEpoch, applyFunding, claim, claimable, computeFunding, emissionRate, newRightsGlobal, newUserRights,
  participationBps, recordHouseEarnings, recordHouseResult, stake, unstake,
} from "./rights";
import type { Position } from "./types";

const usd = (s: string) => parseUnits(s, 6);
/** 1 DIME base unit per USDC base unit keeps the ledger tests readable; real-rate tests below. */
const R1 = { ...P, dimePerUsdE18: 10n ** 6n };
const RESERVE = parseUnits("10", 6);
const px = (n: number) => BigInt(n) * PRICE_SCALE;

function pos(over: Partial<Position> = {}): Position {
  const collateral = over.collateral ?? usd("0.10");
  const leverage = over.leverage ?? 1000;
  const side = over.side ?? "LONG";
  const entryPrice = over.entryPrice ?? px(100_000);
  return {
    id: "p1", route: "HOUSE", side, collateral, leverage, notional: notionalOf(collateral, leverage), entryPrice,
    liquidationPrice: liquidationPrice(side, entryPrice, leverage, P.maintenanceBps),
    houseReservation: collateral * 20n, matchedMaxGrossWin: collateral, feeBps: P.profitFeeBps,
    configVersion: 1, openedAt: 0, provenance: "CONFIRMED", ...over,
  };
}

describe("fixed point", () => {
  it("floor/ceil division handle signs", () => {
    expect(floorDiv(-7n, 2n)).toBe(-4n);
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(ceilDiv(7n, 2n)).toBe(4n);
    expect(ceilDiv(-7n, 2n)).toBe(-3n);
  });
  it("parses and formats exactly", () => {
    expect(parseUnits("0.10", 6)).toBe(100_000n);
    expect(formatUnits(100_000n, 6)).toBe("0.1");
    expect(() => parseUnits("0.0000001", 6)).toThrow();
    expect(fmtAmount(4n, 6, 2, { prefix: "$" })).toBe("<$0.01");
    expect(fmtAmount(-1_234_567n, 6, 2, { prefix: "$" })).toBe("−$1.23");
  });
});

describe("position maths", () => {
  it("gross exposure is margin × leverage", () => {
    expect(notionalOf(usd("0.10"), 1000)).toBe(usd("100"));
  });

  it("liquidation price for 1000× long sits 0.09% below entry with 10% maintenance", () => {
    const lp = liquidationPrice("LONG", px(100_000), 1000, 1000);
    expect(lp).toBe(px(100_000) - px(90));
    expect(liquidationPrice("SHORT", px(100_000), 1000, 1000)).toBe(px(100_000) + px(90));
  });

  it("rounds trader P&L toward -inf", () => {
    // 1 unit notional, 1/3 move → 0.333 floors to 0 for winner, -1 for loser
    expect(rawGrossPnl("LONG", 1n, 3n, 4n)).toBe(0n);
    expect(rawGrossPnl("SHORT", 1n, 3n, 4n)).toBe(-1n);
  });

  it("fee is 25% of positive realised P&L only, never of principal", () => {
    expect(profitFee(usd("1"), 2500)).toBe(usd("0.25"));
    expect(profitFee(-usd("1"), 2500)).toBe(0n);
    const p = pos();
    const s = settle(p, px(100_100), "USER", 1); // +0.1% on $100 notional = +$0.10 gross
    expect(s.grossPnl).toBe(usd("0.10"));
    expect(s.fee).toBe(usd("0.025"));
    expect(s.netPnl).toBe(usd("0.075"));
    expect(s.returned).toBe(usd("0.175"));
  });

  it("losses are limited to committed collateral", () => {
    const s = settle(pos(), px(90_000), "USER", 1);
    expect(s.grossPnl).toBe(-usd("0.10"));
    expect(s.returned).toBe(0n);
  });

  it("house wins are capped at the reservation", () => {
    const p = pos();
    const { gross, capped } = cappedGrossPnl(p, px(110_000));
    expect(gross).toBe(p.houseReservation);
    expect(capped).toBe(true);
  });

  it("liquidation consumes full collateral", () => {
    const p = pos();
    expect(isLiquidatable(p, p.liquidationPrice)).toBe(true);
    expect(settle(p, p.liquidationPrice, "LIQUIDATION", 1).returned).toBe(0n);
  });
});

describe("matched pairs", () => {
  const long = pos({ id: "L", route: "MATCHED", side: "LONG" });
  const short = pos({
    id: "S", route: "MATCHED", side: "SHORT",
    liquidationPrice: liquidationPrice("SHORT", px(100_000), 1000, P.maintenanceBps),
  });

  it("winner is paid from loser's collateral minus fee; fee is house revenue", () => {
    const r = settleMatchedPair(long, short, px(100_050), "USER", "S", 1); // +$0.05 to long
    expect(r.loser.grossPnl).toBe(-usd("0.05"));
    expect(r.winner.grossPnl).toBe(usd("0.05"));
    expect(r.winner.fee).toBe(usd("0.0125"));
    expect(r.houseFee).toBe(usd("0.0125"));
    expect(r.winner.reason).toBe("COUNTERPARTY");
    expect(r.loser.reason).toBe("USER");
    // Conservation: total returned + house take = total collateral in
    expect(r.winner.returned + r.loser.returned + r.houseFee + r.dust - r.houseGapPaid).toBe(long.collateral + short.collateral);
  });

  it("winner cannot receive more than opposing collateral when backstop is 0 (gap)", () => {
    const r = settleMatchedPair(long, short, px(101_000), "USER", "L", 1); // raw +$1 to long
    expect(r.winner.grossPnl).toBe(short.collateral);
    expect(r.winner.capped).toBe(true);
    expect(r.houseGapPaid).toBe(0n);
  });

  it("liquidation settles both sides and passes the buffer to the winner", () => {
    const r = settleMatchedPair(long, short, long.liquidationPrice, "LIQUIDATION", null, 1);
    expect(r.loser.returned).toBe(0n);
    expect(r.loser.reason).toBe("LIQUIDATION");
    expect(r.winner.reason).toBe("COUNTERPARTY_LIQUIDATED");
    expect(r.winner.grossPnl).toBe(long.collateral);
  });
});

describe("house admission", () => {
  it("rejects when reservation exceeds capacity", () => {
    const book = { reserve: usd("10"), reservedLiabilities: usd("7"), netDirectionalNotional: 0n, openHousePositions: 3 };
    const a = admitHouseTrade(book, "LONG", usd("0.10"), 1000, P);
    expect(a.ok).toBe(false);
  });
  it("admits within capacity", () => {
    const book = { reserve: usd("10"), reservedLiabilities: 0n, netDirectionalNotional: 0n, openHousePositions: 0 };
    expect(admitHouseTrade(book, "SHORT", usd("0.10"), 1000, P).ok).toBe(true);
  });
});

describe("rights", () => {
  it("issues only above the net-loss high-water mark and activates next epoch", () => {
    const g = newRightsGlobal();
    const u = newUserRights();
    expect(recordHouseResult(u, g, -usd("0.10"), R1, RESERVE)).toBe(usd("0.10"));
    expect(u.pendingEpoch).toBe(2);
    // wins back 0.10 net, then loses 0.10 again: cumulative net loss back to 0.10 → no new issuance
    expect(recordHouseResult(u, g, usd("0.10"), R1, RESERVE)).toBe(0n);
    expect(recordHouseResult(u, g, -usd("0.10"), R1, RESERVE)).toBe(0n);
    // a further loss above the HWM issues again
    expect(recordHouseResult(u, g, -usd("0.05"), R1, RESERVE)).toBe(usd("0.05"));
    expect(participationBps(u, g)).toBe(0);
    advanceEpoch(g);
    expect(g.totalActive).toBe(usd("0.15"));
    expect(participationBps(u, g)).toBe(10_000);
  });

  it("funds only from new earnings above the earnings high-water mark and reserve floor", () => {
    const g = newRightsGlobal();
    const u = newUserRights();
    recordHouseResult(u, g, -usd("1"), R1, RESERVE);
    recordHouseEarnings(g, usd("1"));
    // no active rights yet → nothing funded, earnings not consumed
    expect(computeFunding(g, usd("11"), 0n, P).limitedBy).toBe("NO_ACTIVE_RIGHTS");
    advanceEpoch(g);
    // reserve 10.5 with floor 10 → surplus 0.5; target 20% × 1 = 0.2
    const f = computeFunding(g, usd("10.5"), 0n, P);
    expect(f.target).toBe(usd("0.2"));
    expect(f.funded).toBe(usd("0.2"));
    applyFunding(g, f);
    // lazily-activated user receives rewards funded after their activation epoch began
    expect(claimable(u, g)).toBe(usd("0.2"));
    expect(claim(u, g)).toBe(usd("0.2"));
    expect(claimable(u, g)).toBe(0n);
    // a house loss must be recovered before new distributions
    recordHouseEarnings(g, -usd("0.5"));
    recordHouseEarnings(g, usd("0.3"));
    expect(computeFunding(g, usd("20"), 0n, P).eligibleNewEarnings).toBe(0n);
  });

  it("reserve floor limits funding", () => {
    const g = newRightsGlobal();
    const u = newUserRights();
    recordHouseResult(u, g, -usd("1"), R1, RESERVE);
    advanceEpoch(g);
    recordHouseEarnings(g, usd("1"));
    const f = computeFunding(g, usd("10.05"), 0n, P);
    expect(f.funded).toBe(usd("0.05"));
    expect(f.limitedBy).toBe("RESERVE_FLOOR");
  });
});

describe("DIME issuance and staking", () => {
  it("issues 10 DIME per $1 up to $1M, then falls with the cube of the reserve", () => {
    const E18 = 10n ** 18n;
    expect(emissionRate(P, usd("10"))).toBe(10n * E18);
    expect(emissionRate(P, usd("1000000"))).toBe(10n * E18);
    expect(emissionRate(P, usd("2000000"))).toBe(125n * 10n ** 16n); // 10 / 8
    expect(emissionRate(P, usd("5000000"))).toBe(8n * 10n ** 16n); // 10 / 125
    expect(emissionRate(P, usd("10000000"))).toBe(10n ** 16n); // 10 / 1000
    const g = newRightsGlobal();
    const u = newUserRights();
    expect(recordHouseResult(u, g, -usd("0.10"), P, usd("10"))).toBe(E18); // 1 DIME
  });

  it("caps DIME issued per epoch", () => {
    const g = newRightsGlobal();
    const capped = { ...P, dimePerUsdE18: 10n ** 17n, maxMintPerEpoch: 15n * 10n ** 15n }; // 0.1 DIME/$, cap 0.015 DIME
    expect(recordHouseResult(newUserRights(), g, -usd("0.10"), capped, usd("10"))).toBe(10n ** 16n);
    expect(recordHouseResult(newUserRights(), g, -usd("0.10"), capped, usd("10"))).toBe(5n * 10n ** 15n);
    expect(recordHouseResult(newUserRights(), g, -usd("0.10"), capped, usd("10"))).toBe(0n);
  });

  it("stake activates next epoch; unstake takes pending first, then active", () => {
    const g = newRightsGlobal();
    const u = newUserRights();
    stake(u, g, 100n);
    expect(participationBps(u, g)).toBe(0);
    advanceEpoch(g);
    expect(participationBps(u, g)).toBe(10_000);
    stake(u, g, 50n); // pending again
    unstake(u, g, 70n); // 50 pending + 20 active
    expect(u.pending).toBe(0n);
    expect(u.active).toBe(80n);
    expect(g.totalActive).toBe(80n);
    expect(() => unstake(u, g, 81n)).toThrow();
  });
});
