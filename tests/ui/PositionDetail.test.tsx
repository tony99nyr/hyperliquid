/**
 * PositionDetail drill-down tests — health read, when-opened label, follow toggle.
 * The chart (lightweight-charts) is stubbed; the leader_actions/follows reads are
 * skipped via the `override` test seam.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PositionDetail from '@/app/cockpit/components/left-rail/PositionDetail';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

vi.mock('@/app/cockpit/components/left-rail/PositionHistoryChart', () => ({ default: () => <div data-testid="chart-stub" /> }));

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

function pos(over: Partial<HlPosition> = {}): HlPosition {
  return {
    coin: 'ETH', side: 'long', szi: 1, size: 1, entryPx: 90, positionValue: 100,
    unrealizedPnl: 10, returnOnEquity: 0.1, leverage: 5, leverageType: 'cross',
    liquidationPx: 70, marginUsed: 20, maxLeverage: 25, ...over,
  };
}

beforeEach(() => fetchMock.mockClear());

describe('PositionDetail', () => {
  it('shows a HEALTHY badge when far from liquidation (mark 100 vs liq 70)', () => {
    render(<PositionDetail leaderAddress="0xABC" position={pos()} onBack={() => {}} override={{ openedAtMs: Date.UTC(2026, 5, 1), following: false }} />);
    expect(screen.getByTestId('position-health').textContent).toMatch(/HEALTHY/);
  });

  it('shows NEAR LIQ when within 5% (mark 100 vs liq 97)', () => {
    render(<PositionDetail leaderAddress="0xABC" position={pos({ liquidationPx: 97 })} onBack={() => {}} override={{ openedAtMs: null, following: false }} />);
    expect(screen.getByTestId('position-health').textContent).toMatch(/NEAR LIQ/);
  });

  it('labels the open time as "first detected" when known, else "held before we watched"', () => {
    const { unmount } = render(<PositionDetail leaderAddress="0xABC" position={pos()} onBack={() => {}} override={{ openedAtMs: Date.UTC(2026, 5, 1), following: false }} />);
    expect(screen.getByTestId('position-opened').textContent).toMatch(/first detected/i);
    unmount(); // override is a read-once mount seam → remount for the other case
    render(<PositionDetail leaderAddress="0xABC" position={pos()} onBack={() => {}} override={{ openedAtMs: null, following: false }} />);
    expect(screen.getByTestId('position-opened').textContent).toMatch(/held before we watched/i);
  });

  it('back button calls onBack', () => {
    const onBack = vi.fn();
    render(<PositionDetail leaderAddress="0xABC" position={pos()} onBack={onBack} override={{ openedAtMs: null, following: false }} />);
    fireEvent.click(screen.getByTestId('position-detail-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('follow button posts a follow action to the route', async () => {
    render(<PositionDetail leaderAddress="0xABC" position={pos()} onBack={() => {}} override={{ openedAtMs: null, following: false }} />);
    fireEvent.click(screen.getByTestId('position-follow'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/cockpit/follows');
    expect(JSON.parse(String(opts.body))).toMatchObject({ leaderAddress: '0xabc', coin: 'ETH', action: 'follow' });
  });
});
