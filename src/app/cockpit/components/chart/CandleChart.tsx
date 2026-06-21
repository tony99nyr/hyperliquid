'use client';

/**
 * CandleChart — the cockpit's star: a streaming TradingView lightweight-charts
 * candlestick panel themed to the trading-desk palette. CLIENT-ONLY (it touches
 * `document` + holds a chart instance) and loaded via next/dynamic with
 * ssr:false from CandleChartPanel so SSR never crashes.
 *
 * Streaming: candles[] is fetched/polled by useCandles upstream; this component
 * `setData`s on a full refresh and `update`s the forming candle as the live
 * last price ticks between polls (the HL ws has no candle channel — we synthesize
 * the in-progress candle's close/high/low from lastPx). MAs (20/50) overlay the
 * price. The active trade's entry/stop/target render as createPriceLine on the
 * price scale, with an entry marker on the series.
 *
 * All data prep is PURE (candle-chart-helpers.ts); this file is the thin
 * imperative bridge to the charts lib.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { css } from '@styled-system/css';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type Time,
} from 'lightweight-charts';
import type { PriceCandle } from '@/types/trading-core';
import {
  buildTradeLines,
  maLine,
  toLwcCandles,
  type ActiveTrade,
} from './candle-chart-helpers';
import { GH, ZONE_COLORS, TERM } from '../panel-styles';

export interface CandleChartProps {
  candles: PriceCandle[];
  /** Live last price from the ws — drives the forming candle between polls. */
  lastPx?: number | null;
  /** Active trade to overlay (entry/stop/target lines). */
  trade?: ActiveTrade | null;
  height?: number;
  /** Coin + interval identify the dataset; a change re-fits the view ONCE. */
  coin?: string;
  interval?: string;
  /** Feed status — the forming candle only streams when 'live'. */
  status?: string;
}

// Design handoff: MA20 = accent #5b8cff, MA50 = warn/gold #d9a441.
const MA_FAST = { period: 20, color: '#5b8cff' };
const MA_SLOW = { period: 50, color: '#d9a441' };

export default function CandleChart({
  candles,
  lastPx = null,
  trade = null,
  height = 460,
  coin,
  interval,
  status,
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const maFastRef = useRef<ISeriesApi<'Line'> | null>(null);
  const maSlowRef = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  // Effective render height, decided ONCE at mount (this is a client-only
  // ssr:false island, so `window` is safe and there is no SSR/first-paint flip
  // that would re-trigger autoSize → the canvas can't overflow its card). On a
  // phone-width viewport we render a compact chart so the focal Open-Positions
  // panel sits in view directly beneath it (design 11-mobile-cockpit).
  const [effectiveHeight] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 1023) {
      return Math.min(height, 250);
    }
    return height;
  });
  // The dataset (coin|interval) we last fitContent()'d for — we re-fit ONCE per
  // dataset, never on subsequent polls (which would destroy user pan/zoom).
  const fittedKeyRef = useRef<string | null>(null);

  // --- Create the chart once, themed to the terminal palette. ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: TERM.surface },
        textColor: GH.textMuted,
        fontFamily:
          "var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: TERM.hairline },
        horzLines: { color: TERM.hairline },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: GH.border, labelBackgroundColor: TERM.raised },
        horzLine: { color: GH.border, labelBackgroundColor: TERM.raised },
      },
      rightPriceScale: { borderColor: GH.border },
      timeScale: { borderColor: GH.border, timeVisible: true, secondsVisible: false },
      // Don't trap the mouse wheel: let it scroll the PAGE over the chart (the
      // "scroll past the chart is annoying" fix). Pan via drag, zoom via pinch
      // (mobile) or the time/price axes — wheel zoom is the only thing disabled.
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      autoSize: true,
      height: effectiveHeight,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: ZONE_COLORS.ok,
      downColor: ZONE_COLORS.danger,
      borderUpColor: ZONE_COLORS.ok,
      borderDownColor: ZONE_COLORS.danger,
      wickUpColor: ZONE_COLORS.ok,
      wickDownColor: ZONE_COLORS.danger,
      priceLineColor: GH.textMuted,
    });
    const maFast = chart.addSeries(LineSeries, {
      color: MA_FAST.color,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const maSlow = chart.addSeries(LineSeries, {
      color: MA_SLOW.color,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    maFastRef.current = maFast;
    maSlowRef.current = maSlow;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      maFastRef.current = null;
      maSlowRef.current = null;
      priceLinesRef.current = [];
      fittedKeyRef.current = null;
    };
    // Create ONCE. `height` is applied imperatively in the effect below so a
    // height change never tears down + rebuilds the chart (which would wipe the
    // user's pan/zoom and re-fit).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Apply height imperatively (no teardown when it changes). ---
  useEffect(() => {
    chartRef.current?.applyOptions({ height: effectiveHeight });
  }, [effectiveHeight]);

  // --- Feed candle + MA data (full refresh on each candles change). ---
  useEffect(() => {
    const series = candleSeriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const lwc = toLwcCandles(candles);
    series.setData(lwc as never);
    maFastRef.current?.setData(maLine(candles, MA_FAST.period) as never);
    maSlowRef.current?.setData(maLine(candles, MA_SLOW.period) as never);
    // Fit the view ONCE per dataset (coin|interval). Subsequent polls just
    // refresh data and must preserve the user's pan/zoom — re-fitting every
    // poll would yank them back to the full range each tick.
    const key = `${coin ?? ''}|${interval ?? ''}`;
    if (lwc.length > 0 && fittedKeyRef.current !== key) {
      chart.timeScale().fitContent();
      fittedKeyRef.current = key;
    }
  }, [candles, coin, interval]);

  // --- Stream the forming candle from the live last price between polls. ---
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || lastPx == null || candles.length === 0) return;
    // Only stream when the feed is live: right after a coin switch the previous
    // coin's lastPx can still be in flight; gating prevents it smearing the new
    // coin's first forming bar.
    if (status !== undefined && status !== 'live') return;
    // Derive the forming-bar time from the SAME deduped output setData() used —
    // reading the raw candles array can pick a same-second duplicate that
    // toLwcCandles dropped, which would create a phantom bar via update().
    const lwc = toLwcCandles(candles);
    if (lwc.length === 0) return;
    const last = lwc[lwc.length - 1];
    series.update({
      time: last.time as Time,
      open: last.open,
      high: Math.max(last.high, lastPx),
      low: Math.min(last.low, lastPx),
      close: lastPx,
    } as never);
  }, [lastPx, candles, status]);

  // --- Overlay the active trade: entry/stop/target price lines. ---
  // NOTE: no on-bar entry marker — we don't store the entry candle's time, so a
  // marker pinned to the latest candle would float on the right edge and lie
  // about when the trade opened. The entry price LINE conveys entry accurately.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];

    const lines = buildTradeLines(trade ?? null, {
      entry: TERM.accent,
      stop: ZONE_COLORS.danger,
      target: ZONE_COLORS.ok,
    });
    for (const l of lines) {
      priceLinesRef.current.push(
        series.createPriceLine({
          price: l.price,
          color: l.color,
          lineWidth: 1,
          lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          title: l.title,
        }),
      );
    }
  }, [trade]);

  // `flexShrink: 0` + `minHeight` keep the canvas from collapsing to a sliver
  // when the panel is a flex column on mobile (autoSize's ResizeObserver would
  // otherwise follow a shrunk container down to a few px — the cut-off chart bug).
  // Mobile: a fixed height (the dynamic value rides a CSS var so Panda's static
  // extraction is happy). Desktop (lg): FILL the panel — flex-grow + autoSize's
  // ResizeObserver sizes the canvas to the available container height (the left
  // column is just tabs + chart, so it fills cleanly without the mobile
  // scroll-context churn).
  return (
    <div
      ref={containerRef}
      data-testid="candle-chart"
      style={{ '--chart-h': `${effectiveHeight}px` } as CSSProperties}
      className={css({
        width: '100%',
        flexShrink: 0,
        height: { base: 'var(--chart-h)', lg: 'auto' },
        minHeight: { base: 'var(--chart-h)', lg: '0' },
        flexGrow: { base: 0, lg: 1 },
      })}
    />
  );
}
