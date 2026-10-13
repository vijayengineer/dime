"use client";

import { useEffect, useRef } from "react";
import {
  AreaSeries, createChart, LastPriceAnimationMode, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { PRICE_DECIMALS } from "@/config/protocol";
import { toFloat } from "@/domain/fixed";
import type { PricePoint } from "@/domain/types";

export interface ChartLine { price: bigint; label: string; kind: "entry" | "liq" | "preview-liq" }

const COLORS = { chalk: "#fffaee", grid: "rgba(243,236,220,0.08)", text: "#cdc6b6", entry: "#f2d06b", liq: "#ff8a7a" };

/** BTC indicative price (model estimate) with entry and liquidation markers. Display only: floats never re-enter accounting. */
export function PriceChart({ points, lines, ariaLabel }: { points: PricePoint[]; lines: ChartLine[]; ariaLabel: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Area"> | null>(null);
  const drawn = useRef<IPriceLine[]>([]);
  const lastT = useRef(0);
  const linePrices = useRef<number[]>([]);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: COLORS.text, fontFamily: "var(--font-jet), monospace", attributionLogo: false },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 6 },
      crosshair: { vertLine: { color: "rgba(243,236,220,0.3)", labelBackgroundColor: "#34322e" }, horzLine: { color: "rgba(243,236,220,0.3)", labelBackgroundColor: "#34322e" } },
      handleScale: { axisPressedMouseMove: true },
    });
    const s = c.addSeries(AreaSeries, {
      lineColor: COLORS.chalk, lineWidth: 3, topColor: "rgba(255,250,238,0.34)", bottomColor: "rgba(110,84,255,0.04)",
      lastPriceAnimation: LastPriceAnimationMode.Continuous,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 }, lastValueVisible: true, priceLineVisible: false,
      // Keep entry/liquidation markers inside the visible range.
      autoscaleInfoProvider: (base: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const r = base();
        if (!r || !linePrices.current.length) return r;
        return { ...r, priceRange: {
          minValue: Math.min(r.priceRange.minValue, ...linePrices.current),
          maxValue: Math.max(r.priceRange.maxValue, ...linePrices.current),
        } };
      },
    });
    chart.current = c;
    series.current = s;
    return () => { c.remove(); chart.current = null; series.current = null; lastT.current = 0; };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s || !points.length) return;
    // lightweight-charts renders timestamps as UTC; shift to local wall-clock for display.
    const tz = new Date().getTimezoneOffset() * 60;
    const toBar = (p: PricePoint) => ({ time: (Math.floor(p.t / 1000) - tz) as UTCTimestamp, value: toFloat(p.price, PRICE_DECIMALS) });
    if (lastT.current === 0) {
      const dedup = new Map<number, ReturnType<typeof toBar>>();
      for (const p of points) { const b = toBar(p); dedup.set(b.time, b); }
      s.setData([...dedup.values()]);
      lastT.current = points[points.length - 1].t;
    } else {
      for (const p of points) if (p.t > lastT.current) { s.update(toBar(p)); lastT.current = p.t; }
    }
  }, [points]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    drawn.current.forEach((l) => s.removePriceLine(l));
    linePrices.current = lines.map((l) => toFloat(l.price, PRICE_DECIMALS));
    drawn.current = lines.map((l) => s.createPriceLine({
      price: toFloat(l.price, PRICE_DECIMALS),
      color: l.kind === "entry" ? COLORS.entry : COLORS.liq,
      lineWidth: 2,
      lineStyle: l.kind === "preview-liq" ? LineStyle.Dotted : LineStyle.Dashed,
      axisLabelVisible: true,
      title: l.label,
    }));
    chart.current?.priceScale("right").applyOptions({ autoScale: true });
  }, [lines]);

  return <div className="chart-box" ref={box} role="img" aria-label={ariaLabel} />;
}
