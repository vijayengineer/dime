import { PRICE_DECIMALS } from "@/config/protocol";
import { fmtAmount } from "@/domain/fixed";

/** USDC display. Decimals come from verified config; 6 is the USDC default. */
export const usd = (v: bigint, dp = 2, sign = false, decimals = 6) => fmtAmount(v, decimals, dp, { prefix: "$", sign });
export const price = (v: bigint, dp = 2) => fmtAmount(v, PRICE_DECIMALS, dp, { prefix: "$" });
export const rights = (v: bigint) => fmtAmount(v, 6, 2);
export const pct = (bps: number, dp = 2) => `${(bps / 100).toFixed(dp)}%`;
export const shortHash = (h?: string) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "—");
export const ago = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`);
export const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
