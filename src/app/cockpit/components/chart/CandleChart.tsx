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

import { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
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
  /** Active trade to overlay (entry/stop/target lines + entry marker). */
  trade?: ActiveTrade | null;
  height?: number;
}

const MA_FAST = { period: 20, color: '#58a6ff' };
const MA_SLOW = { period: 50, color: '#d29922' };

export default function CandleChart({
  candles,
  lastPx = null,
  trade = null,
  height = 460,
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const maFastRef = useRef<ISeriesApi<'Line'> | null>(null);
  const maSlowRef = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

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
      autoSize: true,
      height,
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
    markersRef.current = createSeriesMarkers(candleSeries, []);

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      maFastRef.current = null;
      maSlowRef.current = null;
      markersRef.current = null;
      priceLinesRef.current = [];
    };
  }, [height]);

  // --- Feed candle + MA data (full refresh on each candles change). ---
  useEffect(() => {
    const series = candleSeriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const lwc = toLwcCandles(candles);
    series.setData(lwc as never);
    maFastRef.current?.setData(maLine(candles, MA_FAST.period) as never);
    maSlowRef.current?.setData(maLine(candles, MA_SLOW.period) as never);
    if (lwc.length > 0) chart.timeScale().fitContent();
  }, [candles]);

  // --- Stream the forming candle from the live last price between polls. ---
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || lastPx == null || candles.length === 0) return;
    const last = candles[candles.length - 1];
    const time = Math.floor(last.timestamp / 1000);
    series.update({
      time: time as Time,
      open: last.open,
      high: Math.max(last.high, lastPx),
      low: Math.min(last.low, lastPx),
      close: lastPx,
    } as never);
  }, [lastPx, candles]);

  // --- Overlay the active trade: entry/stop/target price lines + entry marker. ---
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

    // Entry marker pinned to the most-recent candle (we don't store the entry
    // candle time; the line carries the precise price, the marker just flags side).
    if (trade && trade.entryPx != null && candles.length > 0) {
      const time = Math.floor(candles[candles.length - 1].timestamp / 1000);
      markersRef.current?.setMarkers([
        {
          time: time as Time,
          position: trade.side === 'long' ? 'belowBar' : 'aboveBar',
          color: trade.side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger,
          shape: trade.side === 'long' ? 'arrowUp' : 'arrowDown',
          text: trade.side.toUpperCase(),
        },
      ]);
    } else {
      markersRef.current?.setMarkers([]);
    }
  }, [trade, candles]);

  return <div ref={containerRef} data-testid="candle-chart" style={{ width: '100%', height }} />;
}
