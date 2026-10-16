import { describe, expect, it } from "vitest";
import { DEFAULTS, rateAt, simulate, throughput } from "./model";

describe("farming lab model", () => {
  it("mirrors the cubic issuance curve", () => {
    expect(rateAt(10, 1e6, 5e5, "cubic")).toBe(10);
    expect(rateAt(10, 1e6, 2e6, "cubic")).toBeCloseTo(1.25);
    expect(rateAt(10, 1e6, 5e6, "cubic")).toBeCloseTo(0.08);
    expect(rateAt(10, 1e6, 5e6, "inverse")).toBeCloseTo(2);
  });

  it("a farmer alone can't recover their own spend: stakers get only `share` of it back", () => {
    const r = simulate({ ...DEFAULTS, organicLoss: 0, organicEarnings: 0, days: 365 });
    expect(r.farmerUsdc).toBeLessThanOrEqual(r.farmerCost * DEFAULTS.share + 1e-6);
    expect(r.paybackDay).toBeNull();
  });

  it("hedged farming mints 1/fee more DIME per $ than one-sided; netting linked wallets removes that", () => {
    const base = { ...DEFAULTS, organicLoss: 0, organicEarnings: 0, days: 2 };
    const hedged = simulate(base).farmerDime;
    expect(simulate({ ...base, strategy: "oneSided" }).farmerDime * 4).toBeCloseTo(hedged);
    expect(simulate({ ...base, netLinked: true }).farmerDime * 4).toBeCloseTo(hedged);
  });

  it("wallet lifetime is bounded by the deposit cap", () => {
    const t = throughput({ ...DEFAULTS, spend: 10, days: 1 }, 1000, 0.025, 100, 10);
    expect(t.margin).toBeCloseTo(0.1);
    expect(t.eligiblePerWalletLifetime).toBeCloseTo(40);
  });
});
