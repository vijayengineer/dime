"use client";

import { useEffect, useRef, useState } from "react";
import { brand } from "@/config/brand";
import type { Hash, Position, Route, Settlement, Side } from "@/domain/types";
import { price, rights as fmtRights, shortHash, usd } from "../format";
import { Sheet } from "../ui";

/* Shareable P&L card in the style of Hyperliquid's: return on margin as the hero, side/leverage chip,
   entry and exit/mark prices, art on the right. Drawn on a 1200×675 canvas, so no image service and
   no new dependency. Every figure comes from a Settlement (or, for an open position, the same
   estimate the position card shows, labelled as such). A loss is shown as a loss, and the DIME line
   carries the same "may earn nothing" caveat as the settlement card. The coin art is decoration,
   not a price path. */

const W = 1200;
const H = 675;

/** What the card draws. Built from a Settlement (closed) or a Position + mark (open, estimate). */
export interface PnlCardData {
  open: boolean;
  side: Side;
  leverage: number;
  route: Route;
  collateral: bigint;
  netPnl: bigint;
  entryPrice: bigint;
  /** Exit price when closed, mark (settlement reference) when open. */
  lastPrice: bigint;
  rightsIssued: bigint;
  at: number;
  tx?: Hash;
}

export function fromSettlement(s: Settlement): PnlCardData {
  return {
    open: false, side: s.side, leverage: s.leverage, route: s.route, collateral: s.collateral, netPnl: s.netPnl,
    entryPrice: s.entryPrice, lastPrice: s.exitPrice, rightsIssued: s.rightsIssued, at: s.closedAt, tx: s.closeTx,
  };
}

export function fromPosition(p: Position, mark: bigint, netPnl: bigint, at: number): PnlCardData {
  return {
    open: true, side: p.side, leverage: p.leverage, route: p.route, collateral: p.collateral, netPnl,
    entryPrice: p.entryPrice, lastPrice: mark, rightsIssued: 0n, at, tx: p.openTx,
  };
}

/** Same thresholds as the settlement hero: sub-dollar results get 3 decimals so rounding never flatters. */
const dp = (v: bigint) => (v > -1_000_000n && v < 1_000_000n ? 3 : 2);

/** Net P&L as a signed percentage of margin, to one decimal (truncated toward zero, so never flattering). */
function roi(d: PnlCardData): string {
  if (d.collateral === 0n) return "—";
  const tenthsPct = (d.netPnl * 1000n) / d.collateral; // 1 = 0.1%
  const sign = tenthsPct > 0n ? "+" : tenthsPct < 0n ? "-" : "";
  const a = tenthsPct < 0n ? -tenthsPct : tenthsPct;
  return `${sign}${(a / 10n).toLocaleString("en-US")}.${a % 10n}%`;
}

export function shareText(d: PnlCardData): string {
  const side = d.side === "LONG" ? "long" : "short";
  const head = d.open
    ? `Open BTC ${side} at ${d.leverage}× on ${brand.name}: ${roi(d)} (${usd(d.netPnl, dp(d.netPnl), true)} est., not settled)`
    : `Closed a BTC ${side} at ${d.leverage}× on ${brand.name}: ${roi(d)} (${usd(d.netPnl, dp(d.netPnl), true)} net)`;
  return d.rightsIssued > 0n ? `${head}. The loss earned ${fmtRights(d.rightsIssued)} ${brand.name}, staked.` : `${head}.`;
}

/* ------------------------------------------------------------------ themes */

export type CardTheme = "night" | "monad" | "paper";
export const THEMES: { id: CardTheme; label: string }[] = [
  { id: "night", label: "Night" },
  { id: "monad", label: "Monad" },
  { id: "paper", label: "Paper" },
];

interface Palette { bg: [string, string]; ink: string; dim: string; muted: string; line: string; up: string; down: string; gold: string; goldFill: string; glow: string; chipInk: string }
const PALETTE: Record<CardTheme, Palette> = {
  night: {
    bg: ["#1d1b19", "#121110"], ink: "#f3ecdc", dim: "#cdc6b6", muted: "#9e978a", line: "rgba(243,236,220,0.14)",
    up: "#74e2d1", down: "#ff9d7c", gold: "#f7dc8c", goldFill: "rgba(242,208,107,0.08)", glow: "rgba(110,84,255,0.24)", chipInk: "#171615",
  },
  monad: {
    bg: ["#2a1a7a", "#0e0a24"], ink: "#ffffff", dim: "#d9d2ff", muted: "#a49bd6", line: "rgba(255,255,255,0.16)",
    up: "#7ef0d8", down: "#ffa78a", gold: "#f7dc8c", goldFill: "rgba(242,208,107,0.10)", glow: "rgba(160,140,255,0.30)", chipInk: "#0e0a24",
  },
  paper: {
    bg: ["#f6f0e2", "#ebe2cf"], ink: "#171615", dim: "#3d3a35", muted: "#6b655b", line: "rgba(23,22,21,0.16)",
    up: "#0f7a6b", down: "#c2481f", gold: "#8a6a10", goldFill: "rgba(160,120,20,0.08)", glow: "rgba(110,84,255,0.14)", chipInk: "#f6f0e2",
  },
};

function cssFont(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

let monadMark: Promise<HTMLImageElement | null> | undefined;
function loadMonadMark() {
  monadMark ??= new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = "/brand/monad/Logomark.svg";
  });
  return monadMark;
}

/* ------------------------------------------------------------------ drawing */

export interface CardOptions { theme: CardTheme; showAmount: boolean; showPrices: boolean; demo: boolean }

export function drawPnlCard(c: HTMLCanvasElement, d: PnlCardData, o: CardOptions, mark: HTMLImageElement | null) {
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  if (!g) return;
  const P = PALETTE[o.theme];
  const display = cssFont("--font-display", "cursive");
  const body = cssFont("--font-body", "system-ui, sans-serif");
  const mono = cssFont("--font-mono", "ui-monospace, monospace");

  const win = d.netPnl > 0n;
  const flat = d.netPnl === 0n;
  const pnlInk = win ? P.up : flat ? P.ink : P.down;
  const sideInk = d.side === "LONG" ? P.up : P.down;
  const earned = d.rightsIssued > 0n;

  // Board.
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, P.bg[0]);
  bg.addColorStop(1, P.bg[1]);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const glow = (x: number, y: number, r: number, col: string) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, col);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);
  };
  glow(1000, 352, 470, P.glow);

  drawCoin(g, 1000, 352, 220, display, body);

  g.strokeStyle = P.line;
  g.lineWidth = 2;
  g.strokeRect(1, 1, W - 2, H - 2);

  const L = 72;
  g.textBaseline = "alphabetic";
  g.textAlign = "left";

  // Header: wordmark + Monad attribution.
  g.fillStyle = P.ink;
  g.font = `700 60px ${display}`;
  g.fillText(brand.name, L, 112);
  let hx = L + g.measureText(brand.name).width + 22;
  if (mark) {
    g.drawImage(mark, hx, 84, 26, 26);
    hx += 34;
  }
  g.fillStyle = P.muted;
  g.font = `500 22px ${body}`;
  g.fillText(brand.chainLine, hx, 105);

  // Market row: BTC-USD, side/leverage chip, route (and OPEN for an unsettled position).
  const rowY = 176;
  g.fillStyle = P.ink;
  g.font = `700 32px ${body}`;
  g.fillText("BTC-USD", L, rowY);
  let x = L + g.measureText("BTC-USD").width + 18;
  x = chip(g, x, rowY, `${d.side === "LONG" ? "Long" : "Short"} ${d.leverage}×`, mono, { fill: sideInk, ink: P.chipInk }) + 10;
  x = chip(g, x, rowY, d.route === "HOUSE" ? "House" : "Matched", body, { stroke: P.line, ink: P.dim }) + 10;
  if (d.open) chip(g, x, rowY, "Open · estimate", body, { stroke: P.gold, ink: P.gold });

  // Hero: return on margin, shrunk to stay clear of the coin.
  const hero = roi(d);
  let size = 168;
  g.font = `700 ${size}px ${mono}`;
  while (g.measureText(hero).width > 630 && size > 80) {
    size -= 6;
    g.font = `700 ${size}px ${mono}`;
  }
  const heroY = 340;
  g.fillStyle = pnlInk;
  g.fillText(hero, L - 6, heroY);

  let y = heroY + 54;
  if (o.showAmount) {
    g.font = `600 36px ${mono}`;
    const amt = usd(d.netPnl, dp(d.netPnl), true);
    g.fillText(amt, L, y);
    const aw = g.measureText(amt).width;
    g.fillStyle = P.muted;
    g.font = `400 24px ${body}`;
    g.fillText(`${d.open ? "est. net P&L" : "net P&L after fees"} · ${usd(d.collateral, 2)} margin`, L + aw + 16, y - 2);
  } else {
    g.fillStyle = P.muted;
    g.font = `400 24px ${body}`;
    g.fillText(d.open ? "estimated return on margin, after fees" : "return on margin, after fees", L, y - 6);
  }

  // DIME earned (house-route losses only).
  if (earned) {
    y += 26;
    g.fillStyle = P.goldFill;
    g.strokeStyle = P.gold;
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(L, y, 660, 74, 14);
    g.fill();
    g.stroke();
    g.fillStyle = P.gold;
    g.font = `700 28px ${mono}`;
    const amt = `+${fmtRights(d.rightsIssued)} ${brand.name}`;
    g.fillText(amt, L + 20, y + 32);
    const aw = g.measureText(amt).width;
    g.font = `500 20px ${body}`;
    g.fillText("earned on this loss, staked", L + 20 + aw + 14, y + 31);
    g.fillStyle = P.dim;
    g.font = `400 17px ${body}`;
    g.fillText("Shares house earnings in USDC. Not a refund; it may earn nothing.", L + 20, y + 58);
  }

  // Price rows, Hyperliquid-style: small label over a large value.
  if (o.showPrices) {
    const ly = earned ? 556 : 528;
    const cols: [string, string][] = [
      ["Entry price", price(d.entryPrice)],
      [d.open ? "Mark price" : "Exit price", price(d.lastPrice)],
    ];
    cols.forEach(([label, value], i) => {
      const cx = L + i * 300;
      g.fillStyle = P.muted;
      g.font = `500 20px ${body}`;
      g.fillText(label, cx, ly);
      g.fillStyle = P.ink;
      g.font = `600 32px ${mono}`;
      g.fillText(value, cx, ly + 40);
    });
  }

  // Footer: time + provenance.
  g.fillStyle = P.muted;
  g.font = `400 20px ${body}`;
  const when = new Date(d.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const prov = o.demo ? "Demo · simulated, not on-chain" : d.open ? "Not settled" : d.tx ? `tx ${shortHash(d.tx)}` : "";
  g.fillText(prov ? `${when} · ${prov}` : when, L, H - 36);
  g.textAlign = "right";
  g.fillText(brand.tagline, W - 40, H - 36);
  g.textAlign = "left";
}

/** Pill with text; returns its right edge. */
function chip(g: CanvasRenderingContext2D, x: number, baseline: number, text: string, font: string, s: { fill?: string; stroke?: string; ink: string }) {
  g.font = `600 22px ${font}`;
  const w = g.measureText(text).width + 28;
  const top = baseline - 30;
  g.beginPath();
  g.roundRect(x, top, w, 40, 20);
  if (s.fill) { g.fillStyle = s.fill; g.fill(); }
  if (s.stroke) { g.strokeStyle = s.stroke; g.lineWidth = 2; g.stroke(); }
  g.fillStyle = s.ink;
  g.fillText(text, x + 14, baseline - 2);
  return x + w;
}

/** Monad logomark outline (public/brand/monad/Logomark.svg), 182×184 viewBox. */
const MONAD_MARK =
  "M90.5358 0C64.3911 0 0 65.2598 0 91.7593C0 118.259 64.3911 183.52 90.5358 183.52C116.681 183.52 181.073 118.258 181.073 91.7593C181.073 65.2609 116.682 0 90.5358 0ZM76.4273 144.23C65.4024 141.185 35.7608 88.634 38.7655 77.4599C41.7703 66.2854 93.62 36.2439 104.645 39.2892C115.67 42.3341 145.312 94.8846 142.307 106.059C139.302 117.234 87.4522 147.276 76.4273 144.23Z";

/** The art: a dime struck in Monad purple. Decorative only, the same on every card. */
function drawCoin(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, display: string, body: string) {
  const purple = "#6E54FF", deep = "#2f1f9e", light = "#DDD7FE", ink = "#FBFAF9";
  g.save();
  g.translate(cx, cy);
  g.rotate(-0.16);

  // Thickness: a darker disc offset down-right, so the coin reads as an object.
  g.fillStyle = "#1c1166";
  g.beginPath();
  g.arc(10, 14, r, 0, Math.PI * 2);
  g.fill();

  // Body: metallic purple, lit from the top-left.
  const metal = g.createLinearGradient(-r, -r, r, r);
  metal.addColorStop(0, light);
  metal.addColorStop(0.28, "#9d8bff");
  metal.addColorStop(0.6, purple);
  metal.addColorStop(1, deep);
  g.fillStyle = metal;
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.fill();

  // Reeded edge.
  g.strokeStyle = "rgba(20,10,70,0.45)";
  g.lineWidth = 2.2;
  for (let i = 0; i < 160; i++) {
    const a = (i / 160) * Math.PI * 2;
    g.beginPath();
    g.moveTo(Math.cos(a) * (r - 13), Math.sin(a) * (r - 13));
    g.lineTo(Math.cos(a) * (r - 1), Math.sin(a) * (r - 1));
    g.stroke();
  }

  // Raised rim and recessed field.
  g.lineWidth = 6;
  g.strokeStyle = light;
  g.globalAlpha = 0.85;
  g.beginPath();
  g.arc(0, 0, r - 20, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 1;
  const field = g.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r - 23);
  field.addColorStop(0, "#8f7bff");
  field.addColorStop(1, "#4a35d6");
  g.fillStyle = field;
  g.beginPath();
  g.arc(0, 0, r - 23, 0, Math.PI * 2);
  g.fill();

  // Rim lettering, struck around the top and bottom like a coin legend.
  const legend = (text: string, radius: number, top: boolean) => {
    g.font = `700 24px ${body}`;
    g.fillStyle = ink;
    g.textAlign = "center";
    g.textBaseline = "middle";
    // Each glyph gets an arc equal to its own width (plus tracking), so spacing stays even.
    const arcs = [...text].map((ch) => ({ ch, a: (g.measureText(ch).width + 3) / radius }));
    const total = arcs.reduce((n, x) => n + x.a, 0);
    const dir = top ? 1 : -1;
    let a = (top ? -Math.PI / 2 : Math.PI / 2) - (dir * total) / 2;
    for (const x of arcs) {
      const mid = a + (dir * x.a) / 2;
      g.save();
      g.rotate(mid);
      g.translate(radius, 0);
      g.rotate(dir * Math.PI / 2);
      g.fillText(x.ch, 0, 0);
      g.restore();
      a += dir * x.a;
    }
  };
  legend(`${brand.name} · BUILT ON MONAD`, r - 48, true);
  legend("ONE DIME", r - 48, false);

  // Face: the Monad mark, with the denomination beneath.
  g.save();
  const s = (r * 0.62) / 184;
  g.translate(-91 * s, -92 * s - r * 0.14);
  g.scale(s, s);
  g.shadowColor = "rgba(14,8,50,0.55)";
  g.shadowOffsetX = 4 / s;
  g.shadowOffsetY = 6 / s;
  g.shadowBlur = 8 / s;
  g.fillStyle = ink;
  g.fill(new Path2D(MONAD_MARK));
  g.restore();

  g.fillStyle = ink;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.font = `700 64px ${display}`;
  g.shadowColor = "rgba(14,8,50,0.5)";
  g.shadowOffsetY = 4;
  g.shadowBlur = 6;
  g.fillText("10¢", 0, r * 0.5);
  g.shadowColor = "transparent";

  // Shine.
  const shine = g.createLinearGradient(-r, -r, r * 0.2, r * 0.2);
  shine.addColorStop(0, "rgba(255,255,255,0.35)");
  shine.addColorStop(0.45, "rgba(255,255,255,0)");
  g.fillStyle = shine;
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/* ------------------------------------------------------------------ sheet */

/** Share sheet: preview, style options, and share / copy / download. `d` is a snapshot; pass a stable object. */
export function PnlShareSheet({ d, demo, open, onClose }: { d: PnlCardData | null; demo: boolean; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const [theme, setTheme] = useState<CardTheme>("night");
  const [showAmount, setShowAmount] = useState(true);
  const [showPrices, setShowPrices] = useState(true);

  useEffect(() => {
    if (!open || !d) return;
    let live = true;
    // Wait for the web fonts, otherwise the canvas falls back to system fonts.
    Promise.all([document.fonts.ready, loadMonadMark()]).then(([, mark]) => {
      const c = ref.current;
      if (!live || !c) return;
      drawPnlCard(c, d, { theme, showAmount, showPrices, demo }, mark);
      setUrl(c.toDataURL("image/png"));
    });
    return () => { live = false; };
  }, [open, d, demo, theme, showAmount, showPrices]);

  useEffect(() => { if (!open) { setMsg(undefined); setUrl(undefined); } }, [open]);

  if (!d) return null;

  // From the rendered data URL, so the bytes always match the preview.
  const blob = async () => {
    if (!url) throw new Error("no image");
    return (await fetch(url)).blob();
  };
  const fileName = `${brand.name.toLowerCase()}-pnl-${d.at}.png`;
  const canShareFile = typeof navigator !== "undefined" && "canShare" in navigator;

  async function share() {
    try {
      const file = new File([await blob()], fileName, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text: shareText(d!) });
      else download();
    } catch (e) {
      if ((e as Error).name !== "AbortError") setMsg("Sharing isn't available here. Download the image instead.");
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob() })]);
      setMsg("Image copied. Paste it into a post or chat.");
    } catch {
      setMsg("This browser can't copy images. Download it instead.");
    }
  }
  async function copyText() {
    try {
      await navigator.clipboard.writeText(shareText(d!));
      setMsg("Text copied.");
    } catch {
      setMsg("Couldn't copy the text.");
    }
  }
  function download() {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
  }
  const xHref = `https://x.com/intent/post?text=${encodeURIComponent(shareText(d))}`;

  return (
    <Sheet open={open} onClose={onClose} labelledBy="pnl-share-title">
      <h2 id="pnl-share-title">{d.open ? "Share open position" : "Share this trade"}</h2>
      <p className="note" style={{ marginTop: 0 }}>
        {d.open
          ? "An estimate at the current mark, labelled as open. Final P&L is set at settlement."
          : "Your net result after fees, exactly as settled."}
      </p>
      <canvas ref={ref} hidden />
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={shareText(d)} style={{ width: "100%", height: "auto", borderRadius: 12, border: "1px solid var(--line)", display: "block" }} />
      ) : (
        <div className="note" style={{ aspectRatio: `${W} / ${H}`, display: "grid", placeItems: "center", border: "1px solid var(--line)", borderRadius: 12 }}>Drawing card…</div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }} role="group" aria-label="Card style">
        {THEMES.map((t) => (
          <button key={t.id} className={`btn small${theme === t.id ? " primary" : ""}`} aria-pressed={theme === t.id} onClick={() => setTheme(t.id)}>{t.label}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10 }}>
        <label className="toggle"><input type="checkbox" checked={showAmount} onChange={(e) => setShowAmount(e.target.checked)} /> Show $ amount</label>
        <label className="toggle"><input type="checkbox" checked={showPrices} onChange={(e) => setShowPrices(e.target.checked)} /> Show prices</label>
      </div>
      <div className="sides" style={{ marginTop: 12 }}>
        {canShareFile ? <button className="btn primary" onClick={share} disabled={!url}>Share…</button> : <button className="btn primary" onClick={download} disabled={!url}>Download PNG</button>}
        <button className="btn" onClick={copy} disabled={!url}>Copy image</button>
      </div>
      <div className="sides" style={{ marginTop: 10 }}>
        {canShareFile ? <button className="btn ghost" onClick={download} disabled={!url}>Download PNG</button> : <button className="btn ghost" onClick={copyText}>Copy text</button>}
        <a className="btn ghost" href={xHref} target="_blank" rel="noopener noreferrer" style={{ textAlign: "center", textDecoration: "none", display: "grid", placeItems: "center" }}>Post on X</a>
      </div>
      {msg && <p className="note" role="status">{msg}</p>}
      <p className="note" style={{ marginBottom: 0 }}>X can&apos;t attach images from a link: copy or download the card, then paste it into the post.</p>
    </Sheet>
  );
}
