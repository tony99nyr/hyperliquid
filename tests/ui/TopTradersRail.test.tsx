/**
 * TopTradersRail render tests — ranked rated-trader rows + the deferred action
 * feed slot. Fixtures via the `traders` prop (pre-sliced server-side).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TopTradersRail from '@/app/cockpit/components/left-rail/TopTradersRail';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';

// The drawer fetches live positions on open; stub fetch so it never hits network.
vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true,
  json: async () => ({ ok: true, state: { positions: [], accountValueUsd: 0, stale: false } }),
})) as unknown as typeof fetch);

// The rail now subscribes to the GLOBAL leader tables (trade-watch). Mock the
// realtime hooks so the render never touches the Supabase browser client (absent
// in jsdom). Empty + loaded → the Has-position filter is a live no-op and the
// feed shows its empty state.
vi.mock('@/hooks/useLeaderPositionsTable', () => ({
  useLeaderPositionsTable: () => ({ rows: [], loaded: true, subscribed: true, error: null }),
  // The drawer's useTraderPositions reads this scoped variant; empty+loaded → it
  // falls back to the HL proxy (useTraderDetail, fetch-stubbed above).
  useLeaderPositionsScoped: () => ({ rows: [], loaded: true, subscribed: true, error: null }),
}));
vi.mock('@/hooks/useLeaderActionsFeed', () => ({
  useLeaderActionsFeed: () => ({ rows: [], loaded: true, subscribed: true, error: null }),
}));

const emptyMetrics = {
  sharpe: null, winRate: null, profitFactor: null, maxDrawdownFrac: null,
  aggregatePnlUsd: null, medianHoldHours: null, nFills: null, worstLossVsMedianWin: null,
};

const traders: TopTraderRow[] = [
  { address: '0xaaa', short: '0xaa…aaa', displayName: 'Ace', composite: 9, hasRisk: false, cleanBook: true, tradesTradeableCoin: true, flags: ['CLEAN_BOOK'], allFlags: ['CLEAN_BOOK'], leaderboardTop: true, topCoins: ['ETH', 'BTC'], metrics: { ...emptyMetrics, sharpe: 3.3, winRate: 0.62 } },
  // Risky wallet that DOES trade a tradeable coin (so it survives the default
  // tradeable-only filter for the base render assertions).
  { address: '0xbbb', short: '0xbb…bbb', displayName: null, composite: 3, hasRisk: true, cleanBook: false, tradesTradeableCoin: true, flags: ['DEEP_MARTINGALE'], allFlags: ['DEEP_MARTINGALE', 'LIVE_DEEP_STACK'], leaderboardTop: false, topCoins: ['HYPE'], metrics: emptyMetrics },
];

describe('TopTradersRail', () => {
  it('renders ranked trader rows with composite scores', () => {
    render(<TopTradersRail traders={traders} />);
    const rows = screen.getAllByTestId('top-trader-row');
    expect(rows).toHaveLength(2);
    const scores = screen.getAllByTestId('trader-composite').map((e) => e.textContent);
    expect(scores).toEqual(['9', '3']);
    expect(screen.getByText('Ace')).toBeTruthy();
  });

  it('flags a risky wallet with a RISK chip', () => {
    render(<TopTradersRail traders={traders} />);
    expect(screen.getAllByTestId('trader-risk')).toHaveLength(1);
  });

  it('highlights the followed wallet', () => {
    render(<TopTradersRail traders={traders} followedAddress="0xBBB" />);
    const rows = screen.getAllByTestId('top-trader-row');
    expect(rows[1].getAttribute('data-followed')).toBe('true');
    expect(rows[0].getAttribute('data-followed')).toBe('false');
  });

  it('renders the live leader-action feed', () => {
    render(<TopTradersRail traders={traders} />);
    expect(screen.getByTestId('leader-action-feed')).toBeTruthy();
    // loaded + no rows (mocked) → the feed's empty state.
    expect(screen.getByText(/No recent leader activity/i)).toBeTruthy();
  });

  it('shows an empty state with no traders', () => {
    render(<TopTradersRail traders={[]} />);
    expect(screen.getByText(/No rated wallets/i)).toBeTruthy();
  });

  it('opens the trader-detail drawer when a row is clicked', async () => {
    render(<TopTradersRail traders={traders} />);
    expect(screen.queryByTestId('trader-detail-drawer')).toBeNull();
    fireEvent.click(screen.getAllByTestId('top-trader-row')[1]);
    // findBy* awaits React settling the on-open fetch state update (no act warning).
    const drawer = await screen.findByTestId('trader-detail-drawer');
    expect(drawer.getAttribute('role')).toBe('dialog');
    // The risky trader's flags render with meanings (the safe-to-follow read).
    expect(screen.getByTestId('trader-flags')).toBeTruthy();
    expect(screen.getByTestId('trader-detail-verdict').getAttribute('data-level')).toBe('danger');
  });

  it('closes the drawer on the close button', async () => {
    render(<TopTradersRail traders={traders} />);
    fireEvent.click(screen.getAllByTestId('top-trader-row')[0]);
    expect(await screen.findByTestId('trader-detail-drawer')).toBeTruthy();
    fireEvent.click(screen.getByTestId('trader-detail-close'));
    expect(screen.queryByTestId('trader-detail-drawer')).toBeNull();
  });

  it('renders the filter chips with "Has position" enabled + toggleable', () => {
    render(<TopTradersRail traders={traders} />);
    expect(screen.getByRole('button', { name: /clean book/i }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /hide at-risk/i }).getAttribute('aria-pressed')).toBe('false');
    // Tradeable-only defaults ON.
    expect(screen.getByRole('button', { name: /tradeable only/i }).getAttribute('aria-pressed')).toBe('true');
    // Has position is now LIVE (no longer a deferred/disabled placeholder).
    const hasPos = screen.getByRole('button', { name: /has position/i });
    expect(hasPos.hasAttribute('disabled')).toBe(false);
    expect(hasPos.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(hasPos);
    expect(hasPos.getAttribute('aria-pressed')).toBe('true');
  });

  it('Clean book chip narrows to clean-book wallets only', () => {
    render(<TopTradersRail traders={traders} />);
    expect(screen.getAllByTestId('top-trader-row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /clean book/i }));
    const rows = screen.getAllByTestId('top-trader-row');
    expect(rows).toHaveLength(1);
    expect(screen.getByText('Ace')).toBeTruthy();
  });

  it('Hide at-risk chip drops the risky wallet', () => {
    render(<TopTradersRail traders={traders} />);
    fireEvent.click(screen.getByRole('button', { name: /hide at-risk/i }));
    expect(screen.getAllByTestId('top-trader-row')).toHaveLength(1);
    expect(screen.queryAllByTestId('trader-risk')).toHaveLength(0);
  });

  it('Tradeable-only (default ON) hides wallets that trade none of our coins', () => {
    const withUntradeable: TopTraderRow[] = [
      ...traders,
      { address: '0xccc', short: '0xcc…ccc', displayName: 'Alt', composite: 5, hasRisk: false, cleanBook: true, tradesTradeableCoin: false, flags: [], allFlags: [], leaderboardTop: false, topCoins: ['FARTCOIN'], metrics: emptyMetrics },
    ];
    render(<TopTradersRail traders={withUntradeable} />);
    // Default ON → 0xccc hidden.
    expect(screen.getAllByTestId('top-trader-row')).toHaveLength(2);
    expect(screen.queryByText('Alt')).toBeNull();
    // Toggle OFF → it appears.
    fireEvent.click(screen.getByRole('button', { name: /tradeable only/i }));
    expect(screen.getAllByTestId('top-trader-row')).toHaveLength(3);
    expect(screen.getByText('Alt')).toBeTruthy();
  });
});
