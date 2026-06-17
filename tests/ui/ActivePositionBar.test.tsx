/**
 * ActivePositionBar render tests — the HL-style bottom positions row.
 * Fixtures via userOverride: in-profit, in-loss, flat.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ActivePositionBar from '@/app/cockpit/components/bottom-bar/ActivePositionBar';
import { ZONE_COLORS } from '@/app/cockpit/components/panel-styles';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function pos(side: 'long' | 'short', entry: number): PositionRow {
  return {
    id: 'p1',
    sessionId: 's1',
    coin: 'ETH',
    side,
    sz: 2,
    avgEntryPx: entry,
    realizedPnlUsd: 0,
    feesPaidUsd: 1.5,
    updatedAt: Date.now() - 65_000,
  };
}

function pnl(mark: number, uPnl: number): PnlSnapshot {
  return {
    id: 'n1',
    sessionId: 's1',
    coin: 'ETH',
    realizedPnlUsd: 0,
    unrealizedPnlUsd: uPnl,
    feesPaidUsd: 1.5,
    markPx: mark,
    createdAt: Date.now(),
  };
}

describe('ActivePositionBar', () => {
  it('flat: shows the idle strip and no position row', () => {
    render(<ActivePositionBar sessionId="s1" userOverride={{ positions: [], latestPnlByCoin: {} }} />);
    expect(screen.getByTestId('position-flat')).toBeTruthy();
    expect(screen.queryByTestId('active-position-row')).toBeNull();
  });

  it('in-profit: green P&L hero + long side', () => {
    render(
      <ActivePositionBar
        sessionId="s1"
        userOverride={{ positions: [pos('long', 2000)], latestPnlByCoin: { ETH: pnl(2100, 200) } }}
      />,
    );
    const hero = screen.getByTestId('pnl-hero-usd');
    expect(hero.textContent).toBe('+$200.00');
    expect(hero.style.color).toBe(rgb(ZONE_COLORS.ok));
    expect(screen.getByTestId('position-side').textContent).toBe('LONG');
    // pnlPct = 200 / (2 * 2000) = +5%
    expect(screen.getByTestId('pnl-hero-pct').textContent).toBe('+5.00%');
  });

  it('in-loss: red P&L hero + short side', () => {
    render(
      <ActivePositionBar
        sessionId="s1"
        userOverride={{ positions: [pos('short', 2000)], latestPnlByCoin: { ETH: pnl(2100, -200) } }}
      />,
    );
    const hero = screen.getByTestId('pnl-hero-usd');
    expect(hero.textContent).toBe('−$200.00');
    expect(hero.style.color).toBe(rgb(ZONE_COLORS.danger));
    expect(screen.getByTestId('position-side').textContent).toBe('SHORT');
  });

  it('shows the followed leader summary when a leader is set', () => {
    render(
      <ActivePositionBar
        sessionId="s1"
        leaderAddress="0xabcdef1234"
        leaderPositions={[]}
        userOverride={{ positions: [], latestPnlByCoin: {} }}
      />,
    );
    expect(screen.getByTestId('position-leader').textContent).toContain('leader 0xabcd');
  });
});
