/**
 * RegimeStrip render tests — per-timeframe regime + conf% + RSI as numbers.
 * Fixtures via rowsOverride (keeps the strip inert — no network fetch).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RegimeStrip from '@/app/cockpit/components/right-rail/RegimeStrip';
import { ZONE_COLORS } from '@/app/cockpit/components/panel-styles';
import type { RegimeStripRow } from '@/app/cockpit/components/right-rail/regime-strip-helpers';

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

const rows: RegimeStripRow[] = [
  { timeframe: '1d', regime: 'bullish', confidence: 0.72, rsi: 62, noData: false },
  { timeframe: '8h', regime: 'bearish', confidence: 0.55, rsi: 24, noData: false },
  { timeframe: '1h', regime: 'neutral', confidence: 0.31, rsi: 80, noData: false },
  { timeframe: '15m', regime: 'neutral', confidence: 0, rsi: null, noData: true },
];

describe('RegimeStrip', () => {
  it('renders regime label + confidence% + RSI per timeframe', () => {
    render(<RegimeStrip coin="ETH" rowsOverride={rows} />);
    expect(screen.getByTestId('regime-label-1d').textContent).toBe('BULL');
    expect(screen.getByTestId('regime-conf-1d').textContent).toBe('72%');
    expect(screen.getByTestId('regime-rsi-1d').textContent).toBe('RSI 62');
    expect(screen.getByTestId('regime-label-8h').textContent).toBe('BEAR');
  });

  it('colors bullish green, bearish red', () => {
    render(<RegimeStrip coin="ETH" rowsOverride={rows} />);
    expect(screen.getByTestId('regime-label-1d').style.color).toBe(rgb(ZONE_COLORS.ok));
    expect(screen.getByTestId('regime-label-8h').style.color).toBe(rgb(ZONE_COLORS.danger));
  });

  it('tints RSI by band (oversold green, overbought red)', () => {
    render(<RegimeStrip coin="ETH" rowsOverride={rows} />);
    // 8h RSI 24 → oversold → green
    expect(screen.getByTestId('regime-rsi-8h').style.color).toBe(rgb(ZONE_COLORS.ok));
    // 1h RSI 80 → overbought → red
    expect(screen.getByTestId('regime-rsi-1h').style.color).toBe(rgb(ZONE_COLORS.danger));
  });

  it('shows dashes for a no-data timeframe', () => {
    render(<RegimeStrip coin="ETH" rowsOverride={rows} />);
    expect(screen.getByTestId('regime-label-15m').textContent).toBe('—');
    expect(screen.getByTestId('regime-rsi-15m').textContent).toBe('RSI —');
  });
});
