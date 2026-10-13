import type { Address } from "@/domain/types";

/** Live-mode configuration. Missing values are reported, never defaulted to demo. */
export interface LiveEnv {
  privyAppId: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string | null;
  apiUrl: string;
  streamUrl: string;
  /** Hosted Envio GraphQL. Optional: without it, history and indexer status come from the DIME API (Envio HyperRPC). */
  envioUrl: string | null;
  vault: Address;
  usdc: Address;
  usdcDecimals: number;
}

export function readLiveEnv(): { ok: true; env: LiveEnv } | { ok: false; missing: string[] } {
  const raw = {
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
    NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_STREAM_URL: process.env.NEXT_PUBLIC_STREAM_URL,
    NEXT_PUBLIC_VAULT_ADDRESS: process.env.NEXT_PUBLIC_VAULT_ADDRESS,
    NEXT_PUBLIC_USDC_ADDRESS: process.env.NEXT_PUBLIC_USDC_ADDRESS,
    NEXT_PUBLIC_USDC_DECIMALS: process.env.NEXT_PUBLIC_USDC_DECIMALS,
  };
  const missing = Object.entries(raw).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    env: {
      privyAppId: raw.NEXT_PUBLIC_PRIVY_APP_ID!,
      chainId: Number(raw.NEXT_PUBLIC_CHAIN_ID),
      rpcUrl: raw.NEXT_PUBLIC_RPC_URL!,
      explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL || null,
      apiUrl: raw.NEXT_PUBLIC_API_URL!.replace(/\/$/, ""),
      streamUrl: raw.NEXT_PUBLIC_STREAM_URL!,
      envioUrl: process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL || null,
      vault: raw.NEXT_PUBLIC_VAULT_ADDRESS as Address,
      usdc: raw.NEXT_PUBLIC_USDC_ADDRESS as Address,
      usdcDecimals: Number(raw.NEXT_PUBLIC_USDC_DECIMALS),
    },
  };
}

export const APP_MODE: "demo" | "live" = process.env.NEXT_PUBLIC_APP_MODE === "live" ? "live" : "demo";
