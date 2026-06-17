/**
 * LeaderVsYou render tests (Item 4) — the side-by-side leader/you comparison +
 * alignment readout. User side via userOverride; leader side via leaderPositions.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LeaderVsYou from '@/app/cockpit/components/LeaderVsYou';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

const LEADER = '0xabcdef0000000000000000000000000000001234';

function userPos(side: 'long' | 'short'): PositionRow {
  return { id: 'p1', sessionId: 's1', coin: 'ETH', side, sz: 2, avgEntryPx: 2000, realizedPnlUsd: 0, feesPaidUsd: 0, leverage: 5, updatedAt: Date.now() };
}
function userOverride(side: 'long' | 'short') {
  const positions = [userPos(side)];
  const latestPnlByCoin: Record<string, PnlSnapshot> = {
    ETH: { id: 'n', sessionId: 's1', coin: 'ETH', realizedPnlUsd: 0, unrealizedPnlUsd: 100, feesPaidUsd: 0, markPx: 2050, createdAt: Date.now() },
  };
  return { positions, latestPnlByCoin };
}
function leader(over: Partial<HlPosition> = {}): HlPosition {
  return { coin: 'ETH', side: 'long', szi: 2, size: 2, entryPx: 2000, positionValue: 4000, unrealizedPnl: 100, returnOnEquity: 0.05, leverage: 5, leverageType: 'cross', liquidationPx: 1600, marginUsed: 800, maxLeverage: 25, ...over };
}

describe('LeaderVsYou', () => {
  it('renders nothing when not following a leader', () => {
    render(<LeaderVsYou sessionId={null} coin="ETH" leaderAddress={null} leaderPositions={[]} userOverride={userOverride('long')} />);
    expect(screen.queryByTestId('leader-vs-you')).toBeNull();
  });

  it('renders nothing when the operator holds no position on the coin', () => {
    render(<LeaderVsYou sessionId={null} coin="ETH" leaderAddress={LEADER} leaderPositions={[leader()]} userOverride={{ positions: [], latestPnlByCoin: {} }} />);
    expect(screen.queryByTestId('leader-vs-you')).toBeNull();
  });

  it('🟢 aligned — same side, leader still in', () => {
    render(<LeaderVsYou sessionId={null} coin="ETH" leaderAddress={LEADER} leaderPositions={[leader()]} userOverride={userOverride('long')} />);
    const panel = screen.getByTestId('leader-vs-you');
    expect(panel.getAttribute('data-alignment')).toBe('aligned');
    expect(screen.getByTestId('alignment-label').textContent).toContain('Aligned');
    // Both cards render.
    expect(screen.getByTestId('lvy-card-you')).toBeTruthy();
    expect(screen.getByTestId('lvy-card-leader')).toBeTruthy();
  });

  it('🔴 leader covered/flipped — leader is flat on the coin', () => {
    render(<LeaderVsYou sessionId={null} coin="ETH" leaderAddress={LEADER} leaderPositions={[]} userOverride={userOverride('long')} />);
    expect(screen.getByTestId('leader-vs-you').getAttribute('data-alignment')).toBe('leader-covered');
  });

  it('🔴 leader flipped to the opposite side', () => {
    render(<LeaderVsYou sessionId={null} coin="ETH" leaderAddress={LEADER} leaderPositions={[leader({ side: 'short', szi: -2 })]} userOverride={userOverride('long')} />);
    expect(screen.getByTestId('leader-vs-you').getAttribute('data-alignment')).toBe('leader-covered');
  });
});
