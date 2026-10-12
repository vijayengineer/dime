"use client";

import { useEffect, useRef } from "react";
import {
  BaselineSeries, createChart, LineSeries, type IChartApi, type ISeriesApi, type SeriesType, type UTCTimestamp,
} from "lightweight-charts";
import { toFloat } from "@/domain/fixed";
import type { HousePoint, HouseSnapshot } from "@/domain/types";
import { usd } from "../format";

/* Validated with the dataviz palette checker against the card surface (#1f1e1c):
   gold #b08c1e / purple #8a76ff pass lightness, chroma, CVD and contrast. Long/short reuse the
   app's validated teal/ember. Text stays in chalk tokens. */
const C = { gold: "#b08c1e", purple: "#8a76ff", grid: "rgba(243,236,220,0.06)", text: "#9e978a", up: "#21a593", down: "#e2653d" };
const tz = () => new Date().getTimezoneOffset() * 60;
const t = (ms: number) => (Math.floor(ms / 1000) - tz()) as UTCTimestamp;

function useChart(height: number) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: C.text, fontFamily: "var(--font-jet), monospace", attributionLogo: false, fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: C.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.1 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true },
      crosshair: { vertLine: { color: "rgba(243,236,220,0.3)", labelBackgroundColor: "#34322e" }, horzLine: { color: "rgba(243,236,220,0.3)", labelBackgroundColor: "#34322e" } },
      handleScale: false, handleScroll: false,
    });
    chart.current = c;
    return () => { c.remove(); chart.current = null; };
  }, []);
  return { box, chart, style: { height } };
}

const money = { type: "price" as const, precision: 2, minMove: 0.01 };

/** House funds vs free capacity to back new trades. */
export function FundsChart({ points }: { points: HousePoint[] }) {
  const { box, chart, style } = useChart(220);
  const s = useRef<{ owner: IChartApi; funds: ISeriesApi<SeriesType>; free: ISeriesApi<SeriesType> } | null>(null);
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (!s.current || s.current.owner !== c) { // chart can be recreated (StrictMode remount)
      s.current = {
        owner: c,
        funds: c.addSeries(LineSeries, { color: C.gold, lineWidth: 2, priceFormat: money, title: "House funds", lastValueVisible: true, priceLineVisible: false }),
        free: c.addSeries(LineSeries, { color: C.purple, lineWidth: 2, priceFormat: money, title: "Free to back trades", lastValueVisible: true, priceLineVisible: false }),
      };
    }
    s.current.funds.setData(points.map((p) => ({ time: t(p.t), value: toFloat(p.reserve, 6) })));
    s.current.free.setData(points.map((p) => ({ time: t(p.t), value: toFloat(p.available, 6) })));
  }, [points, chart]);
  return (
    <figure className="hc">
      <figcaption className="hc-head">
        <span className="hc-title">House funds</span>
        <span className="hc-legend"><i style={{ background: C.gold }} />House funds <i style={{ background: C.purple }} />Free to back trades</span>
      </figcaption>
      <div ref={box} style={style} role="img" aria-label={points.length ? `House funds ${usd(points[points.length - 1].reserve)}, free ${usd(points[points.length - 1].available)}` : "House funds chart"} />
    </figure>
  );
}

/** Cumulative house P&L (collected losses + matched fees − net payouts to winners). */
export function PnlChart({ points }: { points: HousePoint[] }) {
  const { box, chart, style } = useChart(150);
  const s = useRef<ISeriesApi<SeriesType> | null>(null);
  const owner = useRef<IChartApi | null>(null);
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (!s.current || owner.current !== c) { // chart can be recreated (StrictMode remount)
      owner.current = c;
      s.current = c.addSeries(BaselineSeries, {
        baseValue: { type: "price", price: 0 }, lineWidth: 2, priceFormat: money, priceLineVisible: false,
        topLineColor: C.up, topFillColor1: "rgba(33,165,147,0.25)", topFillColor2: "rgba(33,165,147,0.02)",
        bottomLineColor: C.down, bottomFillColor1: "rgba(226,101,61,0.02)", bottomFillColor2: "rgba(226,101,61,0.25)",
      });
    }
    s.current.setData(points.map((p) => ({ time: t(p.t), value: toFloat(p.pnl, 6) })));
  }, [points, chart]);
  const last = points[points.length - 1]?.pnl ?? 0n;
  return (
    <figure className="hc">
      <figcaption className="hc-head">
        <span className="hc-title">House P&amp;L</span>
        <span className={`num ${last > 0n ? "up" : last < 0n ? "down" : ""}`}>{usd(last, 2, true)}</span>
      </figcaption>
      <div ref={box} style={style} role="img" aria-label={`Cumulative house P and L ${usd(last, 2, true)}`} />
    </figure>
  );
}

/** Open interest: house-backed longs vs shorts, and matched pairs (each side). */
export function ExposureBars({ h }: { h: HouseSnapshot }) {
  const rows = [
    { label: "House-backed longs", v: h.houseLongNotional, color: C.up },
    { label: "House-backed shorts", v: h.houseShortNotional, color: C.down },
    { label: "Matched (each side)", v: h.matchedNotionalPerSide, color: "var(--chalk-3)" },
  ];
  const max = rows.reduce((m, r) => (r.v > m ? r.v : m), 0n);
  const net = h.houseLongNotional - h.houseShortNotional;
  return (
    <figure className="hc">
      <figcaption className="hc-head">
        <span className="hc-title">Open interest</span>
        <span className="note">house net {net === 0n ? "flat" : `${usd(net < 0n ? -net : net, 0)} ${net > 0n ? "long" : "short"}`}</span>
      </figcaption>
      <div className="oi">
        {rows.map((r) => (
          <div className="oi-row" key={r.label}>
            <span className="oi-label">{r.label}</span>
            <span className="oi-track"><span className="oi-fill" style={{ width: max > 0n ? `${Number((r.v * 1000n) / max) / 10}%` : "0%", background: r.color }} /></span>
            <span className="num oi-val">{usd(r.v, 0)}</span>
          </div>
        ))}
      </div>
      <p className="note" style={{ margin: "8px 0 0" }}>{h.openHousePositions} house · {h.openMatchedPairs} matched open. Matched pairs offset each other until one side&apos;s margin runs out.</p>
    </figure>
  );
}
