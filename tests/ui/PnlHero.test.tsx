/**
 * PnlHero render tests — the big color-coded uPnL hero (USD / % / ROE).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PnlHero from '@/app/cockpit/components/bottom-bar/PnlHero';
import { ZONE_COLORS } from '@/app/cockpit/components/panel-styles';

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe('PnlHero', () => {
  it('renders a positive value in green with signed percent + ROE', () => {
    render(<PnlHero pnlUsd={150.5} pnlPct={3.25} roePct={16.25} />);
    expect(screen.getByTestId('pnl-hero-usd').textContent).toBe('+$150.50');
    expect(screen.getByTestId('pnl-hero-usd').style.color).toBe(rgb(ZONE_COLORS.ok));
    expect(screen.getByTestId('pnl-hero-pct').textContent).toBe('+3.25%');
    expect(screen.getByTestId('pnl-hero-roe').textContent).toBe('+16.25%');
  });

  it('renders a negative value in red', () => {
    render(<PnlHero pnlUsd={-80} pnlPct={-2} roePct={null} />);
    expect(screen.getByTestId('pnl-hero-usd').textContent).toBe('−$80.00');
    expect(screen.getByTestId('pnl-hero-usd').style.color).toBe(rgb(ZONE_COLORS.danger));
    expect(screen.queryByTestId('pnl-hero-roe')).toBeNull();
  });

  it('renders dashes when there is no mark yet', () => {
    render(<PnlHero pnlUsd={null} pnlPct={null} roePct={null} />);
    expect(screen.getByTestId('pnl-hero-usd').textContent).toBe('—');
  });
});
