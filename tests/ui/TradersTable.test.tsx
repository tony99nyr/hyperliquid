/**
 * TradersTable render/interaction tests — the sortable/filterable trader table.
 * Hooks that touch the Supabase browser client are mocked (absent in jsdom).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TradersTable from '@/app/cockpit/components/left-rail/TradersTable';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';

vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true,
  json: async () => ({ ok: true, state: { positions: [], accountValueUsd: 0, stale: false } }),
})) as unknown as typeof fetch);

vi.mock('@/hooks/useLeaderPositionsTable', () => ({
  useLeaderPositionsTable: () => ({ rows: [], loaded: true, subscribed: true, error: null }),
  useLeaderPositionsScoped: () => ({ rows: [], loaded: true, subscribed: true, error: null }),
}));
vi.mock('@/hooks/useLeaderActionsFeed', () => ({
  useLeaderActionsFeed: () => ({ rows: [], loaded: true, subscribed: true, error: null }),
}));

const toggleSpy = vi.fn(async () => {});
vi.mock('@/hooks/useFavorites', () => ({
  useFavorites: () => ({
    favorites: new Set<string>(),
    loading: false,
    isFavorite: () => false,
    toggle: toggleSpy,
    refetch: async () => {},
  }),
}));

const base = {
  sharpe: null, winRate: null, profitFactor: null, maxDrawdownFrac: null,
  aggregatePnlUsd: null, medianHoldHours: null, nFills: 300, worstLossVsMedianWin: null,
};
function t(over: Partial<TopTraderRow>, winRate: number, nFills = 300): TopTraderRow {
  return {
    address: '0x0', short: '0x0', displayName: null, composite: 5, hasRisk: false, cleanBook: false,
    tradesTradeableCoin: true, flags: [], allFlags: [], leaderboardTop: false, topCoins: [],
    metrics: { ...base, winRate, nFills }, ...over,
  };
}

const traders: TopTraderRow[] = [
  t({ address: '0xace', displayName: 'Ace', composite: 9 }, 0.62),
  t({ address: '0xrisk', displayName: 'Risky', composite: 3, hasRisk: true, allFlags: ['DEEP_MARTINGALE'] }, 0.50),
  t({ address: '0xvault', displayName: 'Vaulty', composite: 6, allFlags: ['VAULT_LED'] }, 0.80),
  t({ address: '0xthin', displayName: 'Thinny', composite: 5 }, 0.90, 10),
];

describe('TradersTable', () => {
  it('renders rows sorted by composite desc by default', () => {
    render(<TradersTable traders={traders} />);
    const rows = screen.getAllByTestId('traders-table-row');
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain('Ace'); // composite 9 first
  });

  it('renders RISK, VAULT, and thin badges', () => {
    render(<TradersTable traders={traders} />);
    expect(screen.getAllByTestId('badge-risk')).toHaveLength(1);
    expect(screen.getAllByTestId('badge-vault')).toHaveLength(1);
    expect(screen.getAllByTestId('badge-thin')).toHaveLength(1); // Thinny, 10 fills
  });

  it('clicking a column header sorts by it (winRate desc → Thinny first)', () => {
    render(<TradersTable traders={traders} />);
    fireEvent.click(screen.getByTestId('traders-sort-winRate'));
    const rows = screen.getAllByTestId('traders-table-row');
    expect(rows[0].textContent).toContain('Thinny'); // 0.90 win rate
  });

  it('favorite star toggles via the hook without opening the drawer', () => {
    render(<TradersTable traders={traders} />);
    fireEvent.click(screen.getAllByTestId('favorite-star')[0]);
    expect(toggleSpy).toHaveBeenCalledWith('0xace');
    expect(screen.queryByTestId('trader-detail-drawer')).toBeNull();
  });

  it('Hide risk chip drops the risky wallet', () => {
    render(<TradersTable traders={traders} />);
    fireEvent.click(screen.getByRole('button', { name: /hide risk/i }));
    expect(screen.getAllByTestId('traders-table-row')).toHaveLength(3);
    expect(screen.queryAllByTestId('badge-risk')).toHaveLength(0);
  });

  it('Tradeable-only (default ON) hides untradeable wallets', () => {
    const withAlt = [...traders, t({ address: '0xalt', displayName: 'Alt', tradesTradeableCoin: false }, 0.5)];
    render(<TradersTable traders={withAlt} />);
    expect(screen.queryByText('Alt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /tradeable/i }));
    expect(screen.getByText('Alt')).toBeTruthy();
  });

  it('opens + closes the detail drawer on row click', async () => {
    render(<TradersTable traders={traders} />);
    fireEvent.click(screen.getAllByTestId('traders-table-row')[0]);
    expect(await screen.findByTestId('trader-detail-drawer')).toBeTruthy();
    fireEvent.click(screen.getByTestId('trader-detail-close'));
    expect(screen.queryByTestId('trader-detail-drawer')).toBeNull();
  });

  it('shows an empty state with no traders', () => {
    render(<TradersTable traders={[]} />);
    expect(screen.getByText(/No rated wallets/i)).toBeTruthy();
  });
});
