'use client';

/**
 * PriceChart — a SELF-CONTAINED, props-driven candlestick chart (REBUILT for
 * Phase 1c). Takes candles[] + optional markers + an optional live last-price
 * overlay; computes all geometry via PURE helpers (price-chart-helpers.ts) and
 * renders plain SVG. NO external coupling (no regime config, no asset config, no
 * indicator pipeline) — unlike the vendored MiniChart, this stands alone so it
 * can be dropped anywhere with just data.
 */

import { useMemo } from 'react';
import { css } from '@styled-system/css';
import type { PriceCandle } from '@/types/trading-core';
import {
  buildCandleRects,
  placeMarkers,
  priceRange,
  yForPrice,
  type ChartMarker,
  type ChartViewport,
} from './price-chart-helpers';
import { GH, ZONE_COLORS, fmtPx } from './panel-styles';

export interface PriceChartProps {
  candles: PriceCandle[];
  markers?: ChartMarker[];
  /** Live last price drawn as a dashed horizontal line + right-edge tag. */
  lastPx?: number | null;
  title?: string;
  width?: number;
  height?: number;
}

const DEFAULT_VP: ChartViewport = {
  width: 640,
  height: 320,
  padding: { top: 12, right: 56, bottom: 22, left: 8 },
};

const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

export default function PriceChart({
  candles,
  markers = [],
  lastPx = null,
  title,
  width = DEFAULT_VP.width,
  height = DEFAULT_VP.height,
}: PriceChartProps) {
  const vp: ChartViewport = useMemo(
    () => ({ ...DEFAULT_VP, width, height }),
    [width, height],
  );

  const range = useMemo(() => priceRange(candles, markers), [candles, markers]);
  const rects = useMemo(() => buildCandleRects(candles, range, vp), [candles, range, vp]);
  const placed = useMemo(() => placeMarkers(markers, candles, range, vp), [markers, candles, range, vp]);

  const lastY = lastPx !== null ? yForPrice(lastPx, range, vp) : null;
  const innerRight = vp.width - vp.padding.right;

  return (
    <div data-testid="price-chart" className={css({ display: 'flex', flexDirection: 'column', gap: '4px' })}>
      {title && (
        <span className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>{title}</span>
      )}
      <svg
        viewBox={`0 0 ${vp.width} ${vp.height}`}
        className={css({ width: '100%', height: 'auto' })}
        role="img"
        aria-label={title ? `${title} price chart` : 'price chart'}
      >
        <rect x={0} y={0} width={vp.width} height={vp.height} fill={GH.bg} />

        {/* Y grid + price labels (right axis). */}
        {Y_TICKS.map((t) => {
          const price = range.low + (range.high - range.low) * t;
          const y = yForPrice(price, range, vp);
          return (
            <g key={`y-${t}`}>
              <line x1={vp.padding.left} y1={y} x2={innerRight} y2={y} stroke={GH.borderSubtle} strokeWidth={1} />
              <text x={innerRight + 4} y={y + 3} fill={GH.textMuted} fontSize={9} textAnchor="start">
                {fmtPx(price)}
              </text>
            </g>
          );
        })}

        {/* Candles. */}
        {rects.map((r, i) => {
          const color = r.bullish ? ZONE_COLORS.ok : ZONE_COLORS.danger;
          return (
            <g key={`c-${i}`} data-testid="candle">
              <line x1={r.x} y1={r.wickTop} x2={r.x} y2={r.wickBottom} stroke={color} strokeWidth={1} />
              <rect
                x={r.x - r.width / 2}
                y={r.bodyTop}
                width={r.width}
                height={r.bodyHeight}
                fill={color}
              />
            </g>
          );
        })}

        {/* Markers. */}
        {placed.map((m, i) => {
          const color = m.kind === 'buy' ? ZONE_COLORS.ok : m.kind === 'sell' ? ZONE_COLORS.danger : GH.text;
          const up = m.kind !== 'sell';
          const tri = up
            ? `${m.x},${m.y - 9} ${m.x - 5},${m.y + 1} ${m.x + 5},${m.y + 1}`
            : `${m.x},${m.y + 9} ${m.x - 5},${m.y - 1} ${m.x + 5},${m.y - 1}`;
          return (
            <g key={`m-${i}`} data-testid="chart-marker" data-kind={m.kind}>
              <polygon points={tri} fill={color} />
              {m.label && (
                <text x={m.x} y={up ? m.y - 12 : m.y + 18} fill={color} fontSize={9} textAnchor="middle">
                  {m.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Live last-price overlay. */}
        {lastY !== null && (
          <g data-testid="last-px-line">
            <line
              x1={vp.padding.left}
              y1={lastY}
              x2={innerRight}
              y2={lastY}
              stroke={GH.textBright}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <rect x={innerRight} y={lastY - 8} width={vp.padding.right} height={16} fill={GH.textBright} />
            <text x={innerRight + vp.padding.right / 2} y={lastY + 3} fill={GH.bg} fontSize={9} textAnchor="middle" fontWeight="bold">
              {fmtPx(lastPx)}
            </text>
          </g>
        )}

        {candles.length === 0 && (
          <text x={vp.width / 2} y={vp.height / 2} fill={GH.textMuted} fontSize={12} textAnchor="middle">
            no candle data
          </text>
        )}
      </svg>
    </div>
  );
}
