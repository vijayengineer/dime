"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { TERMS_VERSION } from "@shared/terms";
import type { AccessStatus } from "@/adapters/types";
import { useApp } from "@/state/app";
import { feedValue, useServices } from "@/state/services";
import { Sheet } from "./ui";

interface AccessCtx {
  /** null while unknown or signed out. */
  status: AccessStatus | null;
  /** True when the signed-in wallet may deposit and trade. */
  canTrade: boolean;
  openJoin(): void;
}

const Ctx = createContext<AccessCtx>({ status: null, canTrade: false, openJoin: () => {} });
export const useAccess = () => useContext(Ctx);

/**
 * Live mode: a signed-in wallet joins by signing the current Terms of Use and, while the live test is
 * invite-only, entering an invite code (capped number of wallets). The API enforces both for trades.
 */
export function AccessProvider({ children }: { children: ReactNode }) {
  const s = useServices();
  const { account } = useApp();
  const address = feedValue(account)?.address;
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setStatus(null);
    if (!address) return;
    let alive = true;
    s.access.status(address)
      .then((st) => { if (!alive) return; setStatus(st); setOpen(!(st.terms && st.invited)); })
      .catch(() => { if (alive) setOpen(true); });
    return () => { alive = false; };
  }, [s, address]);

  const canTrade = s.mode === "demo" || (!!status && status.terms && status.invited);
  const openJoin = useCallback(() => setOpen(true), []);
  const value = useMemo(() => ({ status, canTrade, openJoin }), [status, canTrade, openJoin]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {s.mode === "live" && address && open && (
        <JoinSheet address={address} status={status} onJoined={(st) => { setStatus(st); setOpen(false); }} onClose={() => setOpen(false)} />
      )}
    </Ctx.Provider>
  );
}

function JoinSheet({ address, status, onJoined, onClose }: {
  address: `0x${string}`; status: AccessStatus | null; onJoined: (s: AccessStatus) => void; onClose: () => void;
}) {
  const s = useServices();
  const [code, setCode] = useState("");
  const [ticks, setTicks] = useState({ eligible: false, risk: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needCode = !!status?.inviteOnly && !status.invited;
  const full = needCode && status?.slotsLeft === 0;

  async function join() {
    setErr(null);
    setBusy(true);
    try { onJoined(await s.access.join(address, code)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Sheet open onClose={onClose} labelledBy="join-title">
      <h2 id="join-title">{needCode ? "Join the live test" : "Before you trade"}</h2>
      {needCode && status?.maxWallets != null && (
        <p className="note" style={{ marginTop: 0 }}>
          DIME is live on Monad for a small group: {status.maxWallets - (status.slotsLeft ?? 0)} of {status.maxWallets} wallets have joined.
        </p>
      )}
      {full ? (
        <p className="warn-box">The live test is full right now. You can still browse prices, the house and Truth.</p>
      ) : (
        <>
          {needCode && (
            <div className="field">
              <label htmlFor="invite">Invite code</label>
              <input id="invite" className="input" autoComplete="off" autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Enter your code" />
            </div>
          )}
          <ul className="terms-points">
            <li><strong>This is real money.</strong> You trade with USDC on Monad mainnet. Transactions are final.</li>
            <li><strong>This is a hackathon project.</strong> Experimental, unaudited software that may have bugs or stop working.</li>
            <li><strong>You can lose everything you deposit.</strong> At up to 1000× leverage, a tiny price move can liquidate you in seconds.</li>
            <li><strong>Prices are signed by DIME.</strong> The contract checks our signature, not whether the price is fair.</li>
          </ul>
          <label className="terms-check">
            <input type="checkbox" checked={ticks.eligible} onChange={(e) => setTicks({ ...ticks, eligible: e.target.checked })} />
            <span>I am 18 or older and not a resident of, or located in, a restricted jurisdiction (including the United States).</span>
          </label>
          <label className="terms-check">
            <input type="checkbox" checked={ticks.risk} onChange={(e) => setTicks({ ...ticks, risk: e.target.checked })} />
            <span>I have read the <Link href="/terms" target="_blank">Terms of Use</Link> and accept that I am using real money in a hackathon project at my own risk.</span>
          </label>
          {err && <p className="err-box" role="alert">{err}</p>}
          <button className="btn primary block" style={{ marginTop: 12 }}
            disabled={busy || !ticks.eligible || !ticks.risk || (needCode && !code.trim())} onClick={join}>
            {busy ? "Waiting for your wallet…" : needCode ? "Join and sign" : "Accept and sign"}
          </button>
          <p className="note">Signing is free and doesn&apos;t send a transaction. New wallets get a small MON top-up for gas. Terms version {TERMS_VERSION}.</p>
        </>
      )}
      <button className="btn ghost small" onClick={onClose}>Just browsing</button>
    </Sheet>
  );
}
