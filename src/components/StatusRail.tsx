"use client";

import { useEffect, useState } from "react";
import type { IntentStatus, TxProgress } from "@/domain/types";
import { useApp } from "@/state/app";
import { feedValue } from "@/state/services";

export const INTENT_COPY: Record<IntentStatus, string> = {
  // One user-facing state while a request is in flight; routing happens behind it.
  SIGNING: "Confirm in your wallet",
  MATCHING: "Opening your position…",
  QUEUED: "Waiting in line for the house…",
  SUBMITTED: "Opening your position…",
  OPENED: "Position opened",
  CAPACITY_UNAVAILABLE: "Not opened: the house was full",
  EXPIRED: "Not opened: timed out",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

const TX_COPY: Record<TxProgress["stage"], string> = {
  SIGN: "Sign in wallet", SUBMITTED: "Submitted", INCLUDED: "Included", CONFIRMED: "Confirmed on-chain", INDEXED: "Indexed", FAILED: "Failed",
};

/** Persistent transaction/request status. Fades finished items after a while. */
export function StatusRail() {
  const { intent, txs } = useApp();
  const it = feedValue(intent);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const busyIntent = it && ["SIGNING", "MATCHING", "SUBMITTED"].includes(it.status);
  const recentTx = txs.filter((t) => t.stage !== "INDEXED" || now - t.updatedAt < 4000).slice(0, 2);
  if (!busyIntent && !recentTx.length) return null;

  return (
    <div className="rail" aria-live="polite">
      {busyIntent && it && (
        <div className="rail-item">
          <span className="dot busy" />
          <span className="grow">{INTENT_COPY[it.status]}</span>
        </div>
      )}
      {recentTx.map((t) => (
        <div className="rail-item" key={t.id}>
          <span className={`dot ${t.stage === "FAILED" ? "bad" : t.stage === "CONFIRMED" || t.stage === "INDEXED" ? "ok" : "busy"}`} />
          <span className="grow">{t.label} · {TX_COPY[t.stage]}{t.error ? ` — ${t.error}` : ""}</span>
        </div>
      ))}
    </div>
  );
}
