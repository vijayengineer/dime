import type { Address } from "@/domain/types";
import { MAINNET } from "@/config/mainnet";

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
  /** What the deployed contract/backend support (see MAINNET). */
  emissionCurve: "cubic" | "inverse";
  houseQueue: boolean;
}

export function readLiveEnv(): { ok: true; env: LiveEnv } | { ok: false; missing: string[] } {
  // Env vars override; otherwise the public Monad mainnet deployment (src/config/mainnet.ts) is used.
  const raw = {
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID || MAINNET.privyAppId,
    NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID || String(MAINNET.chainId),
    NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL || MAINNET.rpcUrl,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || MAINNET.api,
    NEXT_PUBLIC_STREAM_URL: process.env.NEXT_PUBLIC_STREAM_URL || MAINNET.stream,
    NEXT_PUBLIC_VAULT_ADDRESS: process.env.NEXT_PUBLIC_VAULT_ADDRESS || MAINNET.protocol,
    NEXT_PUBLIC_USDC_ADDRESS: process.env.NEXT_PUBLIC_USDC_ADDRESS || MAINNET.usdc,
    NEXT_PUBLIC_USDC_DECIMALS: process.env.NEXT_PUBLIC_USDC_DECIMALS || String(MAINNET.usdcDecimals),
  };
  const missing = Object.entries(raw).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    env: {
      privyAppId: raw.NEXT_PUBLIC_PRIVY_APP_ID!,
      chainId: Number(raw.NEXT_PUBLIC_CHAIN_ID),
      rpcUrl: raw.NEXT_PUBLIC_RPC_URL!,
      explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL || MAINNET.explorer,
      apiUrl: raw.NEXT_PUBLIC_API_URL!.replace(/\/$/, ""),
      streamUrl: raw.NEXT_PUBLIC_STREAM_URL!,
      envioUrl: process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL || null,
      vault: raw.NEXT_PUBLIC_VAULT_ADDRESS as Address,
      usdc: raw.NEXT_PUBLIC_USDC_ADDRESS as Address,
      usdcDecimals: Number(raw.NEXT_PUBLIC_USDC_DECIMALS),
      emissionCurve: (process.env.NEXT_PUBLIC_EMISSION_CURVE === "cubic" || process.env.NEXT_PUBLIC_EMISSION_CURVE === "inverse"
        ? process.env.NEXT_PUBLIC_EMISSION_CURVE : MAINNET.emissionCurve) as "cubic" | "inverse",
      houseQueue: process.env.NEXT_PUBLIC_HOUSE_QUEUE ? process.env.NEXT_PUBLIC_HOUSE_QUEUE === "1" : MAINNET.houseQueue,
    },
  };
}

/** Live (real money on Monad mainnet) unless NEXT_PUBLIC_APP_MODE=demo selects the paper-trading build. */
export const APP_MODE: "demo" | "live" = process.env.NEXT_PUBLIC_APP_MODE === "demo" ? "demo" : "live";
