import { describe, it, expect } from 'vitest';
import {
  buildRatedWalletRow,
  ratedWalletFromRow,
  buildRatedMetaRow,
  datasetFromMeta,
  type RatedWalletSelectRow,
  type RatedMetaSelectRow,
} from '@/lib/hyperliquid/rated-wallets-rows-business-logic';
import type { RatedWallet, RatedWalletsDataset } from '@/lib/hyperliquid/rated-wallets-service';

const WALLET: RatedWallet = {
  address: '0xecb6000000000000000000000000000000001234',
  short: '0xecb6…1234',
  displayName: null,
  grades: { copyability: { grade: 'A', score10: 8.5 }, survivor: { grade: 'B', score10: 6 } },
  composite: 7.25,
  flags: ['CLEAN_BOOK', 'TRADES_OVERNIGHT_EDT'],
  metrics: { sharpe: 2.56, winRate: 0.62, nFills: 5504 },
  sources: ['copyability', 'survivor'],
  tradingActivity: {
    hourHistogramEdt: Array.from({ length: 24 }, (_, i) => (i === 14 ? 0.5 : 0.5 / 23)),
    daytimeActivePct: 0.7,
    overnightPct: 0.3,
    peakHoursEdt: [14, 15, 9],
    nFillsAnalyzed: 5504,
  },
  leaderboardTop: true,
  anticipationLabel: 'anticipating',
  topCoins: ['ETH', 'BTC'],
  worstOpen: { coin: 'ETH', peakNotionalUsd: 233000, adds: 3 },
};

describe('rated_wallets row round-trip', () => {
  it('buildRatedWalletRow → ratedWalletFromRow reconstructs the wallet', () => {
    const row = buildRatedWalletRow(1700, WALLET);
    expect(row.generation).toBe(1700);
    expect(row.display_name).toBeNull();
    expect(row.leaderboard_top).toBe(true);
    expect(row.top_coins).toEqual(['ETH', 'BTC']);

    // Simulate PostgREST surfacing composite as a numeric string.
    const select: RatedWalletSelectRow = { ...row, composite: '7.25' };
    const back = ratedWalletFromRow(select);
    expect(back).toEqual(WALLET);
  });

  it('handles a sparse/empty wallet (nulls, no optional fields)', () => {
    const sparse: RatedWallet = {
      address: '0xabc',
      short: '0xabc',
      displayName: null,
      grades: {},
      composite: null,
      flags: [],
      metrics: {},
      sources: [],
      tradingActivity: null,
    };
    const row = buildRatedWalletRow(2, sparse);
    expect(row.composite).toBeNull();
    expect(row.trading_activity).toBeNull();
    const back = ratedWalletFromRow({ ...row });
    expect(back.composite).toBeNull();
    expect(back.tradingActivity).toBeNull();
    expect(back.leaderboardTop).toBe(false);
    expect(back.topCoins).toEqual([]);
  });
});

describe('rated_wallets_meta', () => {
  const ds: RatedWalletsDataset = {
    schemaVersion: 1,
    generatedAt: '2026-06-15T03:33:00.000Z',
    description: 'test',
    philosophies: ['consistency', 'skill', 'survivor', 'copyability'],
    watchWindowEdt: { startHour: 8, endHour: 22 },
    knownFlags: ['CLEAN_BOOK'],
    count: 1,
    wallets: [WALLET],
  };

  it('buildRatedMetaRow stamps the active generation + meta fields', () => {
    const row = buildRatedMetaRow(1700, ds, '2026-06-15T04:00:00.000Z');
    expect(row).toMatchObject({
      id: 1,
      active_generation: 1700,
      schema_version: 1,
      count: 1,
      generated_at: '2026-06-15T03:33:00.000Z',
      watch_window_edt: { startHour: 8, endHour: 22 },
    });
  });

  it('datasetFromMeta reassembles the dataset shape', () => {
    const metaSel: RatedMetaSelectRow = {
      active_generation: 1700,
      schema_version: 1,
      description: 'test',
      philosophies: ['copyability'],
      watch_window_edt: { startHour: 8, endHour: 22 },
      known_flags: ['CLEAN_BOOK'],
      count: 1,
      generated_at: '2026-06-15T03:33:00.000Z',
    };
    const out = datasetFromMeta(metaSel, [WALLET]);
    expect(out).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-06-15T03:33:00.000Z',
      count: 1,
      watchWindowEdt: { startHour: 8, endHour: 22 },
    });
    expect(out.wallets).toHaveLength(1);
  });
});
