/** Exact decimal-string → 8-decimal bigint (no floating point on the price path). */
export const PRICE_DECIMALS = 8;
const SCALE = 10n ** 8n;

export function parsePrice(s: string | number): bigint {
  const str = typeof s === "number" ? s.toString() : s;
  if (!/^\d+(\.\d+)?(e[+-]?\d+)?$/i.test(str)) throw new Error(`bad price ${str}`);
  if (/e/i.test(str)) return BigInt(Math.round(Number(str) * 1e8)); // rare; exchanges send plain decimals
  const [w, f = ""] = str.split(".");
  return BigInt(w) * SCALE + BigInt((f + "00000000").slice(0, 8));
}

export function midOf(bid: bigint, ask: bigint): bigint {
  return (bid + ask) / 2n;
}

export function formatPrice(p: bigint): string {
  const w = p / SCALE;
  const f = (p % SCALE).toString().padStart(8, "0");
  return `${w}.${f}`;
}
