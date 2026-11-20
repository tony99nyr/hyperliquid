import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import OpenPositionsPanel from '@/app/cockpit/components/OpenPositionsPanel';
import PositionDetail from '@/app/cockpit/components/left-rail/PositionDetail';
import { ReadOnlyProvider } from '@/app/cockpit/read-only-context';
import type { PositionRow } from '@/hooks/realtime-row-mappers';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

vi.mock('@/app/cockpit/components/left-rail/PositionHistoryChart', () => ({ default: () => <div data-testid="chart-stub" /> }));

const position: PositionRow = {
  id: 'ETH', sessionId: 's', coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 1700,
  realizedPnlUsd: 0, feesPaidUsd: 0, leverage: 5, updatedAt: 0,
};

const leaderPos: HlPosition = {
  coin: 'ETH', side: 'long', szi: 1, size: 1, entryPx: 90, positionValue: 100,
  unrealizedPnl: 10, returnOnEquity: 0.1, leverage: 5, leverageType: 'cross',
  liquidationPx: 70, marginUsed: 20, maxLeverage: 25,
};

const panel = () => (
  <OpenPositionsPanel sessionId={null} positionsOverride={{ positions: [position], latestPnlByCoin: {} }} />
);

describe('read-only viewer (OpenPositionsPanel)', () => {
  it('a viewer sees the position but no order controls', () => {
    render(<ReadOnlyProvider value={true}>{panel()}</ReadOnlyProvider>);
    const row = screen.getByTestId('position-row');
    expect(within(row).getByTestId('position-side').textContent).toBe('LONG');
    expect(within(row).queryByTestId('position-reduce')).toBeNull();
    expect(within(row).queryByTestId('position-close')).toBeNull();
    expect(within(row).queryByTestId('position-adjust-lev')).toBeNull();
    expect(screen.queryByTestId('safe-exit-all')).toBeNull();
    expect(screen.queryByTestId('new-position-button')).toBeNull();
  });

  it('an admin (default) still sees the order controls', () => {
    render(panel());
    expect(screen.getByTestId('position-reduce')).toBeTruthy();
    expect(screen.getByTestId('safe-exit-all')).toBeTruthy();
    expect(screen.getByTestId('new-position-button')).toBeTruthy();
  });
});

describe('read-only viewer (PositionDetail)', () => {
  it('a viewer gets the follow state as text and no Copy or Follow button', () => {
    render(
      <ReadOnlyProvider value={true}>
        <PositionDetail leaderAddress="0xABC" position={leaderPos} onBack={() => {}} onCopy={() => {}} override={{ openedAtMs: null, following: true }} />
      </ReadOnlyProvider>,
    );
    expect(screen.queryByTestId('position-copy')).toBeNull();
    expect(screen.queryByTestId('position-follow')).toBeNull();
    expect(screen.getByTestId('position-follow-state').textContent).toContain('follows');
  });
});
