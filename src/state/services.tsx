"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom, defineChain } from "viem";
import { createDemoServices } from "@/adapters/demo";
import { FeedHub } from "@/adapters/feed";
import { createLiveServices, type WalletBridge } from "@/adapters/live";
import { APP_MODE, readLiveEnv, type LiveEnv } from "@/adapters/live/env";
import type { Feed, Listener, Services, Unsubscribe } from "@/adapters/types";
import type { Account, Address } from "@/domain/types";

const Ctx = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(Ctx);
  if (!s) throw new Error("ServicesProvider missing");
  return s;
}

/** Subscribe to an adapter feed. Re-subscribes when `deps` change. */
export function useFeed<T>(subscribe: (cb: Listener<Feed<T>>) => Unsubscribe, deps: unknown[] = []): Feed<T> {
  const [v, setV] = useState<Feed<T>>({ status: "loading" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => subscribe(setV), deps);
  return v;
}

export function feedValue<T>(f: Feed<T>): T | undefined {
  return f.status === "ok" ? f.value : f.status === "error" ? f.last : undefined;
}

export function ServicesProvider({ children }: { children: ReactNode }) {
  if (APP_MODE === "live") return <LiveRoot>{children}</LiveRoot>;
  return <DemoRoot>{children}</DemoRoot>;
}

function DemoRoot({ children }: { children: ReactNode }) {
  const services = useMemo(() => createDemoServices(), []);
  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}

function LiveRoot({ children }: { children: ReactNode }) {
  // Env and chain must be stable across renders, or the live services would be rebuilt.
  const cfg = useMemo(() => readLiveEnv(), []);
  const chain = useMemo(() => cfg.ok ? defineChain({
    id: cfg.env.chainId, name: cfg.env.chainId === 143 ? "Monad" : "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [cfg.env.rpcUrl] } },
  }) : null, [cfg]);
  if (!cfg.ok || !chain) return <ConfigError missing={cfg.ok ? [] : cfg.missing} />;
  const env = cfg.env;
  return (
    <PrivyProvider
      appId={env.privyAppId}
      config={{
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      <PrivyBridge env={env} chain={chain}>{children}</PrivyBridge>
    </PrivyProvider>
  );
}

function PrivyBridge({ env, chain, children }: { env: LiveEnv; chain: ReturnType<typeof defineChain>; children: ReactNode }) {
  const privy = usePrivy();
  const { wallets } = useWallets();
  const latest = useRef({ privy, wallets });
  latest.current = { privy, wallets };

  const bridge = useMemo<WalletBridge>(() => ({
    account: new FeedHub<Account | null>(),
    login: async () => latest.current.privy.login(),
    logout: async () => latest.current.privy.logout(),
    getAccessToken: () => latest.current.privy.getAccessToken(),
    async getWalletClient() {
      const w = latest.current.wallets[0];
      if (!w) throw new Error("No wallet connected");
      await w.switchChain(env.chainId);
      const provider = await w.getEthereumProvider();
      return createWalletClient({ account: w.address as Address, chain, transport: custom(provider) });
    },
  }), [env.chainId, chain]);

  useEffect(() => {
    if (!privy.ready) return;
    const w = wallets[0];
    if (!privy.authenticated || !w) bridge.account.ok(null);
    else bridge.account.ok({ address: w.address as Address, userId: privy.user?.id ?? "", label: privy.user?.email?.address ?? "Wallet" });
  }, [privy.ready, privy.authenticated, privy.user, wallets, bridge]);

  const services = useMemo(() => createLiveServices(env, bridge), [env, bridge]);
  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}

function ConfigError({ missing }: { missing: string[] }) {
  return (
    <main className="config-error" role="alert">
      <h1>Live mode is not configured</h1>
      <p>These settings are missing, so nothing can be shown. The app does not fall back to demo data in live mode.</p>
      <ul>{missing.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
      <p>Set <code>NEXT_PUBLIC_APP_MODE=demo</code> to run the labelled demo instead.</p>
    </main>
  );
}
