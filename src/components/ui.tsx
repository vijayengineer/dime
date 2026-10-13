"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Feed } from "@/adapters/types";
import type { Provenance } from "@/domain/types";

const provText: Record<Provenance, string> = { ESTIMATE: "Estimate", CONFIRMED: "Contract state", INDEXED: "Indexed" };
const provHelp: Record<Provenance, string> = {
  ESTIMATE: "Indicative value from the pricing model. Not settled.",
  CONFIRMED: "Read from contract state.",
  INDEXED: "From the Envio indexer. May lag the chain.",
};

export function Prov({ p, demo }: { p: Provenance; demo?: boolean }) {
  return (
    <span className={`tag ${p.toLowerCase()}`} title={provHelp[p] + (demo ? " (demo engine)" : "")}>
      {provText[p]}{demo ? " · simulated" : ""}
    </span>
  );
}

/** Renders feed loading/error states explicitly; never hides an error behind stale data. */
export function FeedGate<T>({ feed, label, children }: { feed: Feed<T>; label: string; children: (v: T) => ReactNode }) {
  if (feed.status === "loading") return <div className="empty" aria-busy="true">Loading {label}…</div>;
  if (feed.status === "error") {
    return (
      <div className="err-box" role="alert">
        <strong>{label} unavailable.</strong> {feed.error}
        {feed.last !== undefined && <div className="note">Last good value shown below is out of date.</div>}
        {feed.last !== undefined && <div style={{ opacity: 0.55, marginTop: 8 }}>{children(feed.last)}</div>}
      </div>
    );
  }
  return <>{children(feed.value)}</>;
}

export function Sheet({ open, onClose, labelledBy, children }: { open: boolean; onClose: () => void; labelledBy: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])") ?? []).filter((x) => !x.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  // Portal to <body>: a sheet opened from the sticky header would otherwise sit inside the header's
  // stacking context, underneath the mobile tab bar.
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet rise" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>{children}</div>
    </div>,
    document.body,
  );
}

export function Stat({ label, value, tag, sub }: { label: ReactNode; value: ReactNode; tag?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="label"><span>{label}</span>{tag}</div>
      <div className="value">{value}</div>
      {sub && <div className="note">{sub}</div>}
    </div>
  );
}

/* Hand-drawn icons (stroke only, chalk style) */
export const Icon = {
  up: (p: { className?: string }) => (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
      <path d="M4 24 C 9 20, 12 21, 15 16 S 22 9, 28 6" /><path d="M21 5.5 L 28.5 5.8 L 27 13" />
    </svg>
  ),
  down: (p: { className?: string }) => (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
      <path d="M4 7 C 9 10, 12 10, 15 15 S 22 22, 28 25" /><path d="M21 26 L 28.5 25.5 L 27.5 18" />
    </svg>
  ),
  play: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M3 17 L8 11 L12 14 L20 5" /><path d="M15 5 H20 V10" />
    </svg>
  ),
  house: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 11 L12 4 L20.5 11" /><path d="M5.5 10 V20 H18.5 V10" /><path d="M10 20 V15 H14 V20" />
    </svg>
  ),
  activity: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M4 6 H20" /><path d="M4 12 H16" /><path d="M4 18 H12" />
    </svg>
  ),
  match: () => (
    <svg viewBox="0 0 28 20" width="28" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="7" cy="10" r="5" /><circle cx="21" cy="10" r="5" /><path d="M12 10 H16" />
    </svg>
  ),
  tick: () => (
    <svg viewBox="0 0 60 40" width="60" height="40" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path className="draw" style={{ ["--len" as string]: 80 }} d="M6 22 L22 34 L54 6" />
    </svg>
  ),
};
