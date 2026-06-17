'use client';

/**
 * TimeframeTabs — the chart timeframe selector (1m / 5m / 15m / 1h / 4h / 1d).
 * A compact segmented control; the active tab is accent-highlighted. Switching
 * changes the candle size upstream (CandleChartPanel re-fetches via useCandles).
 */

import { css } from '@styled-system/css';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';

/** The chart display timeframes (distinct from the health-engine analysis set). */
export const CHART_TIMEFRAMES: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export interface TimeframeTabsProps {
  value: CandleInterval;
  onChange: (tf: CandleInterval) => void;
}

export default function TimeframeTabs({ value, onChange }: TimeframeTabsProps) {
  return (
    <div
      data-testid="timeframe-tabs"
      role="group"
      aria-label="Chart timeframe"
      className={css({
        display: 'inline-flex',
        gap: '1px',
        bg: 'cockpit.navIdle',
        border: '1px solid token(colors.github.border)',
        borderRadius: '7px',
        padding: '2px',
      })}
    >
      {CHART_TIMEFRAMES.map((tf) => {
        const active = tf === value;
        return (
          <button
            key={tf}
            type="button"
            aria-pressed={active}
            aria-label={`${tf} timeframe`}
            data-testid={`tf-${tf}`}
            data-active={active}
            onClick={() => onChange(tf)}
            style={
              active
                ? { background: '#1c2536', color: '#e8ebf2' }
                : { color: '#8b95a6' }
            }
            className={css({
              fontFamily: 'mono',
              fontSize: '11px',
              fontWeight: 'medium',
              fontFeatureSettings: '"tnum"',
              paddingX: '9px',
              paddingY: '4px',
              borderRadius: '5px',
              border: 'none',
              cursor: 'pointer',
              transition: 'background 0.12s ease, color 0.12s ease',
              _hover: { color: 'github.textBright' },
            })}
          >
            {tf}
          </button>
        );
      })}
    </div>
  );
}
