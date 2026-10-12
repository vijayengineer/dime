/**
 * Fixed-point helpers. All accounting is bigint in token base units (USDC: 6 decimals)
 * and prices are bigint with PRICE_DECIMALS. Floats are only ever produced for display
 * and charting, never fed back into accounting.
 *
 * Rounding policy (mirrors the contract spec in docs/CONTRACTS.md):
 *   - Amounts owed TO a trader round toward zero (floor for positives).
 *   - Amounts owed BY a trader and protocol fees round away from zero (ceil).
 *   - The resulting dust (< 1 base unit per operation) accrues to the house reserve.
 */

export const BPS = 10_000n;

/** Floor division toward negative infinity (bigint `/` truncates toward zero). */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError("division by zero");
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
}

/** Ceiling division toward positive infinity. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}

export const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const max = (a: bigint, b: bigint) => (a > b ? a : b);
export const abs = (a: bigint) => (a < 0n ? -a : a);

export function mulBpsCeil(x: bigint, bps: number | bigint): bigint {
  return ceilDiv(x * BigInt(bps), BPS);
}
export function mulBpsFloor(x: bigint, bps: number | bigint): bigint {
  return floorDiv(x * BigInt(bps), BPS);
}

/** Parse a decimal string ("0.10") into base units. Rejects excess precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") throw new Error(`invalid amount: ${value}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`too many decimal places (max ${decimals})`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Exact decimal string of a base-unit amount. */
export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/**
 * Display formatter. Shows `dp` decimals (rounded half away from zero for display only),
 * but never hides a non-zero amount as zero: tiny values render as "<0.01".
 */
export function fmtAmount(value: bigint, decimals: number, dp = 2, opts: { sign?: boolean; prefix?: string } = {}): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const drop = decimals - dp;
  let shown: bigint;
  if (drop > 0) {
    const d = 10n ** BigInt(drop);
    shown = (v + d / 2n) / d;
  } else shown = v * 10n ** BigInt(-drop);
  const prefix = opts.prefix ?? "";
  const sign = neg ? "−" : opts.sign && v > 0n ? "+" : "";
  if (shown === 0n && v > 0n) return `${sign}<${prefix}${(1 / 10 ** dp).toFixed(dp)}`;
  const scale = 10n ** BigInt(dp);
  const whole = (shown / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = dp > 0 ? "." + (shown % scale).toString().padStart(dp, "0") : "";
  return `${sign}${prefix}${whole}${frac}`;
}

/** For charts and visual proportions only. */
export function toFloat(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}
