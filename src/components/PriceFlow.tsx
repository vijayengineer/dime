"use client";

import { useEffect, useRef } from "react";
import { PRICE_DECIMALS } from "@/config/protocol";
import { toFloat } from "@/domain/fixed";
import type { PriceSnapshot } from "@/domain/types";

/**
 * Animated price pipeline: exchange venues stream into the DIME index, which is signed and checked
 * by the verifier contract on Monad. Node size, edge strength and particle rate follow each venue's
 * real index weight and link health; motion itself is illustrative.
 */

const CREAM = [255, 250, 238] as const;
const PURPLE = [179, 166, 255] as const;
const BAD = [255, 138, 122] as const;
const WARN = [242, 208, 107] as const;
const SIGN_PER_SEC = 4; // reference proofs are signed every 250ms

type RGB = readonly [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

interface Venue { id: string; label: string; price: string; weight: number; used: boolean; health: "ok" | "partial" | "down"; y: number; emit: number }
interface Particle { edge: string; t: number; dur: number; color: RGB; size: number }

const fmt = (v: bigint) => `$${toFloat(v, PRICE_DECIMALS).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function PriceFlow({ snap }: { snap: PriceSnapshot }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(snap);
  useEffect(() => { latest.current = snap; }, [snap]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mono = getComputedStyle(el).fontFamily;
    let W = 0, H = 0, raf = 0, last = performance.now();
    const particles: Particle[] = [];
    const venues = new Map<string, Venue>();
    const pulse = { index: 0, signer: 0, monad: 0 };
    const ripples: { x: number; y: number; r: number; a: number; color: RGB; grow: number }[] = [];
    let signAcc = 0;

    const resize = () => {
      const r = el.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width; H = r.height;
      el.width = Math.round(W * dpr); el.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const layout = () => {
      const narrow = W < 560;
      return {
        narrow,
        vx: narrow ? Math.max(86, W * 0.28) : Math.min(210, W * 0.2),
        ix: W * (narrow ? 0.6 : 0.5), iy: H / 2, ir: narrow ? 22 : 30,
        sx: W * (narrow ? 0.78 : 0.72), mx: W * (narrow ? 0.92 : 0.9),
      };
    };

    // Sync venue nodes from the latest snapshot. Slots follow the feed's own (stable) source order,
    // so venues with similar weights never swap places.
    const sync = () => {
      const s = latest.current;
      const list = s.sources;
      const gap = H / (list.length + 1);
      const seen = new Set<string>();
      list.forEach((src, i) => {
        seen.add(src.id);
        const h = src.health;
        const health: Venue["health"] = !h ? "ok" : h.connectionsUp === 0 ? "down" : h.connectionsUp < h.connections ? "partial" : "ok";
        const v = venues.get(src.id);
        const targetY = gap * (i + 1);
        const next: Venue = {
          id: src.id, label: src.name.split(" ")[0], price: fmt(src.price), weight: src.weight ?? 0,
          used: src.used !== false && (src.weight ?? 0) > 0 && health !== "down", health,
          y: v ? v.y + (targetY - v.y) * 0.08 : targetY, emit: v?.emit ?? Math.random(),
        };
        venues.set(src.id, next);
      });
      for (const id of [...venues.keys()]) if (!seen.has(id)) venues.delete(id);
    };

    const bezier = (x0: number, y0: number, x1: number, y1: number, t: number) => {
      const cx = x0 + (x1 - x0) * 0.55, u = 1 - t;
      return {
        x: u * u * u * x0 + 3 * u * u * t * cx + 3 * u * t * t * cx + t * t * t * x1,
        y: u * u * u * y0 + 3 * u * u * t * y0 + 3 * u * t * t * y1 + t * t * t * y1,
      };
    };

    const node = (x: number, y: number, r: number, color: RGB, glow: number, fill = 0.14) => {
      const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * (2.2 + glow));
      g.addColorStop(0, rgba(color, 0.28 + glow * 0.35));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r * (2.2 + glow), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba(color, fill + glow * 0.2);
      ctx.strokeStyle = rgba(color, 0.85);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    };

    const text = (s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "center", weight = 500) => {
      ctx.font = `${weight} ${size}px ${mono}`;
      ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = "middle";
      ctx.fillText(s, x, y);
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      sync();
      const L = layout();
      const s = latest.current;
      ctx.clearRect(0, 0, W, H);

      // Edges: venue -> index
      for (const v of venues.values()) {
        const color = v.health === "down" ? BAD : v.health === "partial" ? WARN : CREAM;
        ctx.strokeStyle = rgba(color, v.used ? 0.1 + v.weight * 0.9 : 0.12);
        ctx.lineWidth = v.used ? 1 + v.weight * 7 : 1;
        ctx.setLineDash(v.used ? [] : [3, 5]);
        ctx.beginPath();
        for (let i = 0; i <= 24; i++) {
          const p = bezier(L.vx, v.y, L.ix - L.ir, L.iy, i / 24);
          if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        // Emission ∝ weight (plus a floor so small venues still visibly contribute).
        if (v.used && !reduce) {
          v.emit += dt * (1.5 + v.weight * 18);
          while (v.emit >= 1) { v.emit -= 1; particles.push({ edge: v.id, t: 0, dur: 0.9 + Math.random() * 0.5, color: v.health === "partial" ? WARN : CREAM, size: 1.4 + v.weight * 3 }); }
        }
      }
      // Edges: index -> signer -> monad
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgba(CREAM, 0.25);
      ctx.beginPath(); ctx.moveTo(L.ix + L.ir, L.iy); ctx.lineTo(L.sx - 14, L.iy); ctx.stroke();
      ctx.strokeStyle = rgba(PURPLE, 0.45);
      ctx.beginPath(); ctx.moveTo(L.sx + 14, L.iy); ctx.lineTo(L.mx - 18, L.iy); ctx.stroke();

      const signing = s.quality === "OK" || s.quality === "DEGRADED";
      if (signing && !reduce) {
        signAcc += dt * SIGN_PER_SEC;
        while (signAcc >= 1) { signAcc -= 1; particles.push({ edge: "sign", t: 0, dur: 0.55, color: CREAM, size: 2.6 }); }
      }

      // Particles (additive glow)
      ctx.globalCompositeOperation = "lighter";
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.t += dt / p.dur;
        if (p.t >= 1) {
          particles.splice(i, 1);
          if (p.edge === "sign") { pulse.signer = 1; particles.push({ edge: "chain", t: 0, dur: 0.6, color: PURPLE, size: 3 }); }
          else if (p.edge === "chain") { pulse.monad = 1; ripples.push({ x: L.mx, y: L.iy, r: 16, a: 0.7, color: PURPLE, grow: 70 }); }
          else pulse.index = Math.min(1, pulse.index + 0.12);
          continue;
        }
        let x: number, y: number;
        if (p.edge === "sign") { x = L.ix + L.ir + (L.sx - 14 - L.ix - L.ir) * p.t; y = L.iy; }
        else if (p.edge === "chain") { x = L.sx + 14 + (L.mx - 18 - L.sx - 14) * p.t; y = L.iy; }
        else {
          const v = venues.get(p.edge);
          if (!v) { particles.splice(i, 1); continue; }
          const e = p.t * p.t * (3 - 2 * p.t); // ease in-out
          ({ x, y } = bezier(L.vx, v.y, L.ix - L.ir, L.iy, e));
        }
        const fade = Math.min(1, p.t * 6, (1 - p.t) * 8);
        ctx.fillStyle = rgba(p.color, 0.18 * fade);
        ctx.beginPath(); ctx.arc(x, y, p.size * 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgba(p.color, 0.95 * fade);
        ctx.beginPath(); ctx.arc(x, y, p.size, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      // Ripples where proofs land on Monad
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.r += rp.grow * dt; rp.a -= dt * 0.9;
        if (rp.a <= 0) { ripples.splice(i, 1); continue; }
        ctx.strokeStyle = rgba(rp.color, rp.a); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2); ctx.stroke();
      }
      // Orbit around the index
      if (!reduce) {
        const rot = now / 2600;
        ctx.strokeStyle = rgba(CREAM, 0.22); ctx.lineWidth = 1;
        ctx.setLineDash([2, 7]);
        ctx.beginPath(); ctx.arc(L.ix, L.iy, L.ir + 12, rot, rot + Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        for (let k = 0; k < 3; k++) {
          const a = rot * 1.6 + (k * Math.PI * 2) / 3;
          ctx.fillStyle = rgba(k === 0 ? PURPLE : CREAM, 0.8);
          ctx.beginPath(); ctx.arc(L.ix + Math.cos(a) * (L.ir + 12), L.iy + Math.sin(a) * (L.ir + 12), 2, 0, Math.PI * 2); ctx.fill();
        }
      }

      // Venue nodes + labels
      for (const v of venues.values()) {
        const color = v.health === "down" ? BAD : v.health === "partial" ? WARN : CREAM;
        node(L.vx, v.y, 4 + v.weight * 14, color, 0, v.used ? 0.22 : 0.05);
        const lx = L.vx - (4 + v.weight * 14) - 10;
        text(v.label, lx, v.y - 7, L.narrow ? 11 : 12, v.used ? "rgba(243,236,220,.92)" : "rgba(243,236,220,.4)", "right", 600);
        text(L.narrow ? `${(v.weight * 100).toFixed(0)}%` : `${v.price} · ${(v.weight * 100).toFixed(1)}%`, lx, v.y + 8, 10, "rgba(205,198,182,.7)", "right");
      }

      // Index, signer, Monad
      const breathe = reduce ? 0 : (Math.sin(now / 700) + 1) * 0.08;
      node(L.ix, L.iy, L.ir, CREAM, pulse.index * 0.6 + breathe, 0.18);
      text("DIME", L.ix, L.iy - 4, L.narrow ? 11 : 13, "rgba(255,250,238,1)", "center", 700);
      text("index", L.ix, L.iy + 10, 9, "rgba(205,198,182,.8)");
      text(fmt(s.estimate), L.ix, L.iy + L.ir + 22, L.narrow ? 13 : 16, "rgba(255,250,238,1)", "center", 600);
      if (!L.narrow) text(s.quality === "OK" ? "weighted median" : s.quality.toLowerCase(), L.ix, L.iy + L.ir + 40, 10, "rgba(205,198,182,.7)");

      node(L.sx, L.iy, 12, CREAM, pulse.signer * 0.8, 0.2);
      text("signed", L.sx, L.iy - 30, 10, "rgba(205,198,182,.85)");
      if (s.reference && !L.narrow) text(fmt(s.reference.price), L.sx, L.iy + 30, 11, "rgba(243,236,220,.9)");

      node(L.mx, L.iy, 16, PURPLE, pulse.monad * 0.9 + breathe, 0.25);
      text("Monad", L.mx, L.iy - 34, 11, "rgba(221,215,254,.95)", "center", 600);
      text("verify()", L.mx, L.iy + 34, 10, "rgba(179,166,255,.85)");

      pulse.index *= 0.9; pulse.signer *= 0.88; pulse.monad *= 0.9;
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // With reduced motion, redraw the static diagram when data changes.
    const id = reduce ? setInterval(() => { raf = requestAnimationFrame(frame); }, 2000) : undefined;
    return () => { cancelAnimationFrame(raf); ro.disconnect(); if (id) clearInterval(id); };
  }, []);

  const used = snap.sources.filter((s) => s.used !== false && (s.weight ?? 0) > 0).length;
  return (
    <canvas
      ref={canvas}
      className="price-flow"
      role="img"
      aria-label={`${used} of ${snap.sources.length} exchange feeds flow into the DIME index at ${fmt(snap.estimate)}, which is signed and checked by the verifier contract on Monad.`}
    />
  );
}
