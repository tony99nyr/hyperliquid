import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import OpenPositionsPanel from '@/app/cockpit/components/OpenPositionsPanel';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';

function position(over: Partial<PositionRow> = {}): PositionRow {
  return {
    id: over.coin ?? 'ETH',
    sessionId: 's',
    coin: 'ETH',
    side: 'short',
    sz: 2.5,
    avgEntryPx: 1742,
    realizedPnlUsd: 0,
    feesPaidUsd: 0,
    leverage: 10,
    updatedAt: 0,
    ...over,
  };
}

function pnl(coin: string, markPx: number, uPnl: number): PnlSnapshot {
  return { id: coin, sessionId: 's', coin, realizedPnlUsd: 0, unrealizedPnlUsd: uPnl, feesPaidUsd: 0, markPx, createdAt: 0 };
}

describe('OpenPositionsPanel', () => {
  it('renders the empty state when flat', () => {
    render(<OpenPositionsPanel sessionId={null} positionsOverride={{ positions: [], latestPnlByCoin: {} }} />);
    expect(screen.getByTestId('positions-empty')).toBeTruthy();
    expect(screen.getByTestId('open-count').textContent).toBe('0 open');
    // No Safe-Exit ALL when flat.
    expect(screen.queryByTestId('safe-exit-all')).toBeNull();
  });

  it('renders a position row with side pill, uPnL, alignment badge and liq bar', () => {
    render(
      <OpenPositionsPanel
        sessionId={null}
        regimeByCoin={{ ETH: 'bearish' }}
        positionsOverride={{
          positions: [position({ side: 'short' })],
          latestPnlByCoin: { ETH: pnl('ETH', 1739.5, 6.25) },
        }}
      />,
    );
    const row = screen.getByTestId('position-row');
    expect(within(row).getByTestId('position-side').textContent).toBe('SHORT');
    // short in a bearish regime → ALIGNED
    const badge = within(row).getByTestId('alignment-badge');
    expect(badge.getAttribute('data-aligned')).toBe('true');
    expect(badge.textContent).toContain('ALIGNED');
    // liq bar present with a width
    const bar = within(row).getByTestId('liq-bar');
    expect(bar.style.width.endsWith('%')).toBe(true);
    // Reduce + Close actions present
    expect(within(row).getByTestId('position-reduce')).toBeTruthy();
    expect(within(row).getByTestId('position-close')).toBeTruthy();
    // Safe-Exit ALL shows when there is at least one position
    expect(screen.getByTestId('safe-exit-all')).toBeTruthy();
  });

  it('shows ✓ PROTECTED when a resting stop covers the position', () => {
    render(
      <OpenPositionsPanel
        sessionId={null}
        mode="live"
        positionsOverride={{ positions: [position({ side: 'short' })], latestPnlByCoin: { ETH: pnl('ETH', 1700, 0) } }}
        stopsOverride={{ ETH: { oid: 1, triggerPx: 1751, sz: 2.5 } }}
      />,
    );
    const s = screen.getByTestId('stop-status');
    expect(s.getAttribute('data-state')).toBe('protected');
    expect(s.textContent).toContain('stop');
    expect(s.textContent).toContain('away');
  });

  it('flags ⚠ NO STOP (clickable) in live when the position is unprotected', () => {
    render(
      <OpenPositionsPanel
        sessionId={null}
        mode="live"
        positionsOverride={{ positions: [position({ side: 'short' })], latestPnlByCoin: { ETH: pnl('ETH', 1700, 0) } }}
        stopsOverride={{}}
      />,
    );
    const s = screen.getByTestId('stop-status');
    expect(s.getAttribute('data-state')).toBe('unprotected');
    expect(s.tagName).toBe('BUTTON'); // clickable → opens insights to set one
  });

  it('shows N/A protection in paper (no exchange stops there)', () => {
    render(
      <OpenPositionsPanel
        sessionId={null}
        mode="paper"
        positionsOverride={{ positions: [position({ side: 'short' })], latestPnlByCoin: { ETH: pnl('ETH', 1700, 0) } }}
        stopsOverride={{}}
      />,
    );
    expect(screen.getByTestId('stop-status').getAttribute('data-state')).toBe('na');
  });

  it('uses the REAL HL liquidation + effective leverage (reflects posted margin), not the formula', () => {
    render(
      <OpenPositionsPanel
        sessionId={null}
        mode="live"
        positionsOverride={{ positions: [position({ side: 'short', leverage: 10 })], latestPnlByCoin: { ETH: pnl('ETH', 1739.5, 0) } }}
        riskOverride={{ ETH: { liqPx: 2500, effLeverage: 1.5, marginUsed: 800 } }}
      />,
    );
    // Real liq 2500 vs mark 1739.5 ≈ 43% away — NOT the ~9.8% the 10x formula would give.
    expect(parseFloat(screen.getByTestId('liq-dist').textContent!)).toBeGreaterThan(30);
    // Effective leverage surfaced (1.5x, far below the 10x setting).
    expect(screen.getByTestId('position-eff-lev').textContent).toMatch(/1\.5× eff/);
  });

  it('flags a FIGHTING long against a bearish regime', () => {
    render(
      <OpenPositionsPanel
        sessionId={null}
        regimeByCoin={{ ETH: 'bearish' }}
        positionsOverride={{
          positions: [position({ side: 'long' })],
          latestPnlByCoin: { ETH: pnl('ETH', 1739.5, -6.25) },
        }}
      />,
    );
    const badge = screen.getByTestId('alignment-badge');
    expect(badge.getAttribute('data-aligned')).toBe('false');
    expect(badge.textContent).toContain('FIGHTING');
  });
});
