/**
 * FollowingPanel render tests — empty state, a live followed position (side/uPnL/
 * health + Copy/Unfollow), and a stale follow (leader closed / unwatched). The
 * composing hook is mocked for controlled state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import FollowingPanel from '@/app/cockpit/components/FollowingPanel';
import type { UseFollowingState, FollowingRow } from '@/hooks/useFollowing';
import type { LeaderPositionRow } from '@/hooks/realtime-row-mappers';

let state: UseFollowingState;
const unfollow = vi.fn(async () => {});
vi.mock('@/hooks/useFollowing', () => ({ useFollowing: () => state }));

function leaderPos(over: Partial<LeaderPositionRow> = {}): LeaderPositionRow {
  return {
    id: '0xabc:ETH', leaderAddress: '0xabc0000000000000000000000000000000001234', coin: 'ETH',
    side: 'short', szi: -2, size: 2, entryPx: 1700, positionValue: 3400, unrealizedPnl: 120,
    returnOnEquity: null, leverage: 5, leverageType: 'cross', liquidationPx: 2100,
    accountValueUsd: 50000, fetchedAt: 0, ...over,
  } as LeaderPositionRow;
}

function row(over: Partial<FollowingRow> = {}): FollowingRow {
  return { leaderAddress: '0xabc0000000000000000000000000000000001234', coin: 'ETH', position: leaderPos(), ...over };
}

beforeEach(() => {
  unfollow.mockClear();
  state = { rows: [], loading: false, noFollows: false, unfollow };
});

describe('FollowingPanel', () => {
  it('empty state when nothing is followed', () => {
    state.noFollows = true;
    render(<FollowingPanel />);
    expect(screen.getByTestId('following-empty')).toBeTruthy();
  });

  it('renders a live followed position with side, uPnL, health + actions', () => {
    state.rows = [row()];
    const onCopy = vi.fn();
    render(<FollowingPanel onCopy={onCopy} />);
    const r = screen.getByTestId('following-row');
    expect(within(r).getByTestId('following-health')).toBeTruthy();
    expect(r.textContent).toMatch(/SHORT/);
    expect(r.textContent).toMatch(/ETH/);
    fireEvent.click(within(r).getByTestId('following-copy'));
    expect(onCopy).toHaveBeenCalledWith('ETH', 'short');
    fireEvent.click(within(r).getByTestId('following-unfollow'));
    expect(unfollow).toHaveBeenCalledWith('0xabc0000000000000000000000000000000001234', 'ETH');
  });

  it('disables Copy for a coin the cockpit cannot trade', () => {
    state.rows = [row({ coin: 'WIF', position: leaderPos({ coin: 'WIF' }) })];
    render(<FollowingPanel onCopy={vi.fn()} />);
    expect((screen.getByTestId('following-copy') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('following-copy').getAttribute('title')).toMatch(/tradeable/i);
  });

  it('shows a stale note when the leader no longer holds the position', () => {
    state.rows = [row({ position: null })];
    render(<FollowingPanel />);
    expect(screen.getByTestId('following-stale')).toBeTruthy();
    // Copy is disabled without a side.
    expect((screen.getByTestId('following-copy') as HTMLButtonElement).disabled).toBe(true);
  });
});
