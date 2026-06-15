'use client';

import { useState, useMemo, useCallback, useRef } from 'react';
import { css } from '@styled-system/css';
import type { PriceCandle } from '@/types';
import type { TradingAsset } from '@/lib/infrastructure/config/asset-config';
import { calculateSMA, calculateEMA, calculateRSI, calculateMACD } from '@/lib/strategy/indicators/indicators';
import { calculateRegimeRegionsFromCandles } from '@/lib/strategy/analysis/regime-region-calculator';
import { getRegimeDetectionConfig } from '@/lib/strategy/config/regime-detection-config';

// --- Layout constants ---
const CHART_WIDTH = 600;
const PRICE_H = 270;
const RSI_H = 130;
const MACD_H = 150;
const GAP = 8; // gap between sub-charts
const TOTAL_H = PRICE_H + GAP + RSI_H + GAP + MACD_H;
const PADDING = { top: 16, right: 10, bottom: 18, left: 60 };
const INNER_W = CHART_WIDTH - PADDING.left - PADDING.right;
const DISPLAY_DAYS = 7;
const DISPLAY_CANDLES = Math.ceil((DISPLAY_DAYS * 24) / 8);

// Sub-chart vertical bounds
const PRICE_TOP = PADDING.top;
const PRICE_INNER = PRICE_H - PADDING.top - 4; // small bottom margin
const RSI_TOP = PRICE_H + GAP;
const RSI_INNER = RSI_H - 4;
const MACD_TOP = PRICE_H + GAP + RSI_H + GAP;
const MACD_INNER = MACD_H - PADDING.bottom - 2;

export const MA_COLORS = {
  price: '#58a6ff',
  sma20: '#60a5fa',
  sma50: '#22c55e',
  sma200: '#8b5cf6',
  ema12: '#3b82f6',
  ema26: '#eab308',
  rsi: '#c084fc',
  macdLine: '#58a6ff',
  macdSignal: '#f97316',
  histPos: '#3fb95060',
  histNeg: '#f8514960',
} as const;

function fmtPrice(v: number): string {
  return v >= 1000 ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `$${v.toFixed(0)}`;
}

function computeIndicators(prices: number[]) {
  const pad = <T,>(arr: T[], total: number, fill: T) =>
    Array<T>(total - arr.length).fill(fill).concat(arr);
  const macdRaw = calculateMACD(prices, 12, 26, 9);
  return {
    sma20: pad(calculateSMA(prices, 20), prices.length, null as number | null),
    sma50: pad(calculateSMA(prices, 50), prices.length, null as number | null),
    sma200: pad(calculateSMA(prices, 200), prices.length, null as number | null),
    ema12: pad(calculateEMA(prices, 12), prices.length, null as number | null),
    ema26: pad(calculateEMA(prices, 26), prices.length, null as number | null),
    rsi: pad(calculateRSI(prices, 14), prices.length, null as number | null),
    macd: pad(macdRaw.macd, prices.length, null as number | null),
    macdSignal: pad(macdRaw.signal, prices.length, null as number | null),
    macdHist: pad(macdRaw.histogram, prices.length, null as number | null),
  };
}

interface MiniChartProps {
  asset: TradingAsset;
  candles: PriceCandle[];
}

export default function MiniChart({ asset, candles }: MiniChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const allPrices = useMemo(() => candles.map(c => c.close), [candles]);
  const indicators = useMemo(() => computeIndicators(allPrices), [allPrices]);

  const displayStart = Math.max(0, candles.length - DISPLAY_CANDLES);
  const displayCandles = candles.slice(displayStart);

  // Slice all indicators to display range
  const sl = useMemo(() => {
    const s = (arr: (number | null)[]) => arr.slice(displayStart);
    return {
      sma20: s(indicators.sma20), sma50: s(indicators.sma50), sma200: s(indicators.sma200),
      ema12: s(indicators.ema12), ema26: s(indicators.ema26),
      rsi: s(indicators.rsi),
      macd: s(indicators.macd), macdSignal: s(indicators.macdSignal), macdHist: s(indicators.macdHist),
    };
  }, [indicators, displayStart]);

  // --- Price chart Y range (includes all MAs) ---
  const allVisibleValues = useMemo(() => {
    const vals = displayCandles.map(c => c.close);
    for (const arr of [sl.sma20, sl.sma50, sl.sma200, sl.ema12, sl.ema26]) {
      for (const v of arr) { if (v !== null && Number.isFinite(v)) vals.push(v); }
    }
    return vals;
  }, [displayCandles, sl]);

  const yMin = useMemo(() => Math.min(...allVisibleValues), [allVisibleValues]);
  const yMax = useMemo(() => Math.max(...allVisibleValues), [allVisibleValues]);
  const yPad = (yMax - yMin) * 0.08 || 10;
  const yLow = yMin - yPad;
  const yHigh = yMax + yPad;

  // --- MACD Y range ---
  const macdRange = useMemo(() => {
    const vals: number[] = [];
    for (const arr of [sl.macd, sl.macdSignal, sl.macdHist]) {
      for (const v of arr) { if (v !== null && Number.isFinite(v)) vals.push(v); }
    }
    if (vals.length === 0) return { low: -1, high: 1 };
    const mx = Math.max(...vals.map(Math.abs)) * 1.1 || 1;
    return { low: -mx, high: mx };
  }, [sl]);

  // --- Projection helpers ---
  const xOf = useCallback(
    (index: number) => (index / Math.max(displayCandles.length - 1, 1)) * INNER_W + PADDING.left,
    [displayCandles.length],
  );

  const projectPrice = useCallback(
    (value: number, index: number) => {
      const x = xOf(index);
      const ratio = (value - yLow) / (yHigh - yLow || 1);
      const y = PRICE_TOP + PRICE_INNER - ratio * PRICE_INNER;
      return { x, y };
    },
    [xOf, yLow, yHigh],
  );

  const projectRSI = useCallback(
    (value: number, index: number) => {
      const x = xOf(index);
      const ratio = value / 100; // RSI is 0-100
      const y = RSI_TOP + RSI_INNER - ratio * RSI_INNER;
      return { x, y };
    },
    [xOf],
  );

  const projectMACD = useCallback(
    (value: number, index: number) => {
      const x = xOf(index);
      const ratio = (value - macdRange.low) / (macdRange.high - macdRange.low || 1);
      const y = MACD_TOP + MACD_INNER - ratio * MACD_INNER;
      return { x, y };
    },
    [xOf, macdRange],
  );

  // --- Build SVG paths ---
  const buildPolyline = (values: (number | null)[], proj: (v: number, i: number) => { x: number; y: number }) => {
    const pts: string[] = [];
    values.forEach((v, i) => {
      if (v !== null && i < displayCandles.length) {
        const { x, y } = proj(v, i);
        pts.push(`${x},${y}`);
      }
    });
    return pts.length > 1 ? pts.join(' ') : null;
  };

  const pricePath = displayCandles.map((c, i) => {
    const { x, y } = projectPrice(c.close, i);
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  const sma20Path = buildPolyline(sl.sma20, projectPrice);
  const sma50Path = buildPolyline(sl.sma50, projectPrice);
  const sma200Path = buildPolyline(sl.sma200, projectPrice);
  const ema12Path = buildPolyline(sl.ema12, projectPrice);
  const ema26Path = buildPolyline(sl.ema26, projectPrice);
  const rsiPath = buildPolyline(sl.rsi, projectRSI);
  const macdPath = buildPolyline(sl.macd, projectMACD);
  const macdSigPath = buildPolyline(sl.macdSignal, projectMACD);

  // MACD histogram bars
  const macdZeroY = projectMACD(0, 0).y;

  // --- Regime regions ---
  const regimeRegions = useMemo(() => {
    if (candles.length < 51) return [];
    const config = getRegimeDetectionConfig(asset);
    const regions = calculateRegimeRegionsFromCandles(candles, displayStart, candles.length - 1, config);
    const startTime = displayCandles[0]?.timestamp ?? 0;
    const endTime = displayCandles[displayCandles.length - 1]?.timestamp ?? 0;
    const timeSpan = endTime - startTime || 1;
    return regions
      .filter(r => r.endTime >= startTime && r.startTime <= endTime)
      .map(r => {
        const cs = Math.max(r.startTime, startTime);
        const ce = Math.min(r.endTime, endTime);
        const xStart = ((cs - startTime) / timeSpan) * INNER_W + PADDING.left;
        const xEnd = ((ce - startTime) / timeSpan) * INNER_W + PADDING.left;
        return { regime: r.regime, x: xStart, width: Math.max(1, xEnd - xStart) };
      });
  }, [candles, displayStart, displayCandles, asset]);

  // --- Y-axis labels (price chart) ---
  const priceYLabels = [0, 0.25, 0.5, 0.75, 1].map(ratio => ({
    value: yLow + (yHigh - yLow) * ratio,
    y: PRICE_TOP + PRICE_INNER - ratio * PRICE_INNER,
  }));

  // --- X-axis labels ---
  const xLabels = useMemo(() => {
    if (displayCandles.length < 2) return [];
    const step = Math.max(1, Math.floor(displayCandles.length / 4));
    const labels: { label: string; x: number }[] = [];
    for (let i = 0; i < displayCandles.length; i += step) {
      const candle = displayCandles[i];
      if (!candle) continue;
      const d = new Date(candle.timestamp);
      labels.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, x: xOf(i) });
    }
    return labels;
  }, [displayCandles, xOf]);

  // --- Hover handler (works across all sub-charts) ---
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * CHART_WIDTH;
      if (mx < PADDING.left || mx > PADDING.left + INNER_W) { setHoveredIdx(null); return; }
      const ratio = (mx - PADDING.left) / INNER_W;
      const idx = Math.round(ratio * (displayCandles.length - 1));
      setHoveredIdx(Math.max(0, Math.min(displayCandles.length - 1, idx)));
    },
    [displayCandles.length],
  );

  const hCandle = hoveredIdx !== null ? displayCandles[hoveredIdx] : null;

  // --- Tooltip ---
  const tooltipLines = useMemo(() => {
    if (hoveredIdx === null) return null;
    const c = displayCandles[hoveredIdx];
    if (!c) return null;
    const lines: { label: string; value: string; color: string }[] = [
      { label: 'Price', value: fmtPrice(c.close), color: MA_COLORS.price },
    ];
    const addMA = (name: string, arr: (number | null)[], color: string, fmt?: (v: number) => string) => {
      const v = arr[hoveredIdx];
      if (v !== null) lines.push({ label: name, value: fmt ? fmt(v) : fmtPrice(v), color });
    };
    addMA('SMA20', sl.sma20, MA_COLORS.sma20);
    addMA('SMA50', sl.sma50, MA_COLORS.sma50);
    addMA('SMA200', sl.sma200, MA_COLORS.sma200);
    addMA('EMA12', sl.ema12, MA_COLORS.ema12);
    addMA('EMA26', sl.ema26, MA_COLORS.ema26);
    addMA('RSI', sl.rsi, MA_COLORS.rsi, v => v.toFixed(1));
    addMA('MACD', sl.macd, MA_COLORS.macdLine, v => v.toFixed(1));
    addMA('Signal', sl.macdSignal, MA_COLORS.macdSignal, v => v.toFixed(1));
    addMA('Histogram', sl.macdHist, '#7d8590', v => v.toFixed(1));
    return lines;
  }, [hoveredIdx, displayCandles, sl]);

  const hoverX = hCandle && hoveredIdx !== null ? xOf(hoveredIdx) : null;
  const hoverPctX = hoverX !== null ? (hoverX / CHART_WIDTH) * 100 : 0;

  return (
    <div>
      <div className={css({ fontSize: 'sm', fontWeight: 'medium', color: '#e6edf3', marginBottom: '4px' })}>
        {asset.toUpperCase()} — 7 Day
      </div>
      <div
        ref={containerRef}
        className={css({ position: 'relative', cursor: 'crosshair' })}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <svg viewBox={`0 0 ${CHART_WIDTH} ${TOTAL_H}`} className={css({ width: '100%', height: 'auto' })}>
          <rect x="0" y="0" width={CHART_WIDTH} height={TOTAL_H} fill="#0d1117" />

          {/* ============ PRICE CHART ============ */}
          {/* Regime regions */}
          {regimeRegions.map((r, i) => {
            const color = r.regime === 'bullish' ? 'rgba(63, 185, 80, 0.2)' : r.regime === 'bearish' ? 'rgba(248, 81, 73, 0.2)' : 'rgba(125, 133, 144, 0.1)';
            return <rect key={`r-${i}`} x={r.x} y={PRICE_TOP} width={r.width} height={PRICE_INNER} fill={color} />;
          })}
          {/* Grid + Y labels */}
          {priceYLabels.map((l, i) => (
            <g key={`pg-${i}`}>
              <line x1={PADDING.left} y1={l.y} x2={CHART_WIDTH - PADDING.right} y2={l.y} stroke="#21262d" strokeWidth="1" />
              <text x={PADDING.left - 6} y={l.y + 4} fill="#7d8590" fontSize="10" textAnchor="end">{fmtPrice(l.value)}</text>
            </g>
          ))}
          {/* MAs */}
          {sma200Path && <polyline points={sma200Path} fill="none" stroke={MA_COLORS.sma200} strokeWidth="2" strokeDasharray="6 4" opacity={0.8} />}
          {sma50Path && <polyline points={sma50Path} fill="none" stroke={MA_COLORS.sma50} strokeWidth="1.5" strokeDasharray="4 3" />}
          {ema26Path && <polyline points={ema26Path} fill="none" stroke={MA_COLORS.ema26} strokeWidth="1.5" strokeDasharray="2 4" />}
          {ema12Path && <polyline points={ema12Path} fill="none" stroke={MA_COLORS.ema12} strokeWidth="1.5" strokeDasharray="2 2" opacity={0.8} />}
          {sma20Path && <polyline points={sma20Path} fill="none" stroke={MA_COLORS.sma20} strokeWidth="1.5" strokeDasharray="2 2" opacity={0.8} />}
          <path d={pricePath} fill="none" stroke={MA_COLORS.price} strokeWidth="2" />

          {/* ============ RSI CHART ============ */}
          <line x1={PADDING.left} y1={RSI_TOP} x2={CHART_WIDTH - PADDING.right} y2={RSI_TOP} stroke="#30363d" strokeWidth="1" />
          {/* Bullish sweet spot band (55-70) */}
          {(() => {
            const y70 = RSI_TOP + RSI_INNER - (70 / 100) * RSI_INNER;
            const y55 = RSI_TOP + RSI_INNER - (55 / 100) * RSI_INNER;
            return <rect x={PADDING.left} y={y70} width={INNER_W} height={y55 - y70} fill="rgba(63, 185, 80, 0.08)" />;
          })()}
          {/* Overbought / Oversold reference lines */}
          {[30, 50, 70].map(level => {
            const y = RSI_TOP + RSI_INNER - (level / 100) * RSI_INNER;
            return (
              <g key={`rsi-${level}`}>
                <line x1={PADDING.left} y1={y} x2={CHART_WIDTH - PADDING.right} y2={y} stroke="#21262d" strokeWidth="1" strokeDasharray={level === 50 ? '4 4' : '2 4'} />
                <text x={PADDING.left - 6} y={y + 3} fill="#484f58" fontSize="9" textAnchor="end">{level}</text>
              </g>
            );
          })}
          <text x={PADDING.left - 6} y={RSI_TOP + 10} fill="#7d8590" fontSize="9" textAnchor="end">RSI</text>
          {rsiPath && <polyline points={rsiPath} fill="none" stroke={MA_COLORS.rsi} strokeWidth="1.5" />}

          {/* ============ MACD CHART ============ */}
          <line x1={PADDING.left} y1={MACD_TOP} x2={CHART_WIDTH - PADDING.right} y2={MACD_TOP} stroke="#30363d" strokeWidth="1" />
          {/* Zero line */}
          <line x1={PADDING.left} y1={macdZeroY} x2={CHART_WIDTH - PADDING.right} y2={macdZeroY} stroke="#30363d" strokeWidth="1" strokeDasharray="4 4" />
          <text x={PADDING.left - 6} y={MACD_TOP + 10} fill="#7d8590" fontSize="9" textAnchor="end">MACD</text>
          <text x={PADDING.left - 6} y={macdZeroY + 3} fill="#484f58" fontSize="9" textAnchor="end">0</text>
          {/* Histogram bars */}
          {sl.macdHist.map((v, i) => {
            if (v === null || i >= displayCandles.length) return null;
            const x = xOf(i);
            const barW = Math.max(2, INNER_W / displayCandles.length * 0.6);
            const barY = v >= 0 ? projectMACD(v, i).y : macdZeroY;
            const barH = Math.abs(projectMACD(v, i).y - macdZeroY);
            return <rect key={`mh-${i}`} x={x - barW / 2} y={barY} width={barW} height={Math.max(1, barH)} fill={v >= 0 ? MA_COLORS.histPos : MA_COLORS.histNeg} />;
          })}
          {macdPath && <polyline points={macdPath} fill="none" stroke={MA_COLORS.macdLine} strokeWidth="2" />}
          {macdSigPath && <polyline points={macdSigPath} fill="none" stroke={MA_COLORS.macdSignal} strokeWidth="2" strokeDasharray="4 3" />}

          {/* X-axis labels */}
          {xLabels.map((l, i) => (
            <text key={`x-${i}`} x={l.x} y={TOTAL_H - 2} fill="#484f58" fontSize="9" textAnchor="middle">{l.label}</text>
          ))}

          {/* ============ HOVER CROSSHAIR (spans all sub-charts) ============ */}
          {hoverX !== null && (
            <line x1={hoverX} y1={PRICE_TOP} x2={hoverX} y2={MACD_TOP + MACD_INNER} stroke="#7d8590" strokeWidth="1" strokeDasharray="3 3" />
          )}
          {hCandle && hoveredIdx !== null && (
            <circle cx={projectPrice(hCandle.close, hoveredIdx).x} cy={projectPrice(hCandle.close, hoveredIdx).y} r="3" fill={MA_COLORS.price} />
          )}
        </svg>

        {/* Tooltip */}
        {hCandle && hoveredIdx !== null && tooltipLines && (() => {
          const flipLeft = hoverPctX > 65;
          const d = new Date(hCandle.timestamp);
          const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:00`;
          return (
            <div
              className={css({
                position: 'absolute',
                top: '8px',
                pointerEvents: 'none',
                bg: '#0d1117ee',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '8px 10px',
                fontSize: 'xs',
                zIndex: 10,
                minWidth: '130px',
              })}
              style={flipLeft ? { right: `${100 - hoverPctX + 2}%` } : { left: `${hoverPctX + 2}%` }}
            >
              <div className={css({ color: '#7d8590', marginBottom: '4px' })}>{dateStr}</div>
              {tooltipLines.map(line => (
                <div key={line.label} className={css({ display: 'flex', justifyContent: 'space-between', gap: '12px' })}>
                  <span style={{ color: line.color }}>{line.label}</span>
                  <span className={css({ color: '#e6edf3', fontFamily: 'mono' })}>{line.value}</span>
                </div>
              ))}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
