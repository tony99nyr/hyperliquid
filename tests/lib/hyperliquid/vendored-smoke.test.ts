/**
 * Smoke tests for vendored HL modules that arrived WITHOUT tests from iamrossi.
 * Covers the pure / deterministic surface (address validation, analytics
 * derivation, dataset loading) so they have at least one regression guard here.
 */
import { describe, it, expect } from 'vitest';
import {
  isValidHlAddress,
  normalizeHlAddress,
  type HlClearinghouseState,
  type HlFill,
} from '@/lib/hyperliquid/hyperliquid-info-service';
import { buildCopyMonitorAnalytics } from '@/lib/hyperliquid/copy-monitor-analytics';
import { loadRatedWallets, findRatedWallet, RISK_FLAGS } from '@/lib/hyperliquid/rated-wallets-service';
import type { RatedWallet } from '@/lib/hyperliquid/rated-wallets-service';

describe('hyperliquid-info-service — address helpers (pure)', () => {
  it('validates well-formed 0x addresses', () => {
    expect(isValidHlAddress('0x' + 'a'.repeat(40))).toBe(true);
    expect(isValidHlAddress('  0x' + 'A'.repeat(40) + '  ')).toBe(true);
  });
  it('rejects malformed addresses', () => {
    expect(isValidHlAddress('0x123')).toBe(false);
    expect(isValidHlAddress('not-an-address')).toBe(false);
  });
  it('normalizes to trimmed lowercase', () => {
    expect(normalizeHlAddress('  0xABCDEF  ')).toBe('0xabcdef');
  });
});

describe('copy-monitor-analytics — alert derivation (pure)', () => {
  const leaderState: HlClearinghouseState = {
    address: '0x' + 'a'.repeat(40),
    accountValueUsd: 10_000,
    totalMarginUsed: 0,
    totalNotionalPosition: 0,
    withdrawableUsd: 0,
    positions: [
      {
        coin: 'ETH',
        side: 'long',
        szi: 5,
        size: 5,
        entryPx: 2000,
        positionValue: 10_000,
        unrealizedPnl: -4_000, // > 25% of account value → danger
        returnOnEquity: null,
        leverage: 5,
        leverageType: 'cross',
        liquidationPx: null,
        marginUsed: 2000,
        maxLeverage: 50,
      },
    ],
    fetchedAt: 0,
    stale: false,
  };

  it('flags a deeply-underwater live position as danger', () => {
    const analytics = buildCopyMonitorAnalytics(null, leaderState, []);
    expect(analytics.alerts.some((a) => a.severity === 'danger')).toBe(true);
  });

  it('surfaces rating flags (NO_STOPS → danger)', () => {
    const rating: RatedWallet = {
      address: leaderState.address,
      short: 'aaaa',
      displayName: null,
      grades: {},
      composite: null,
      flags: ['NO_STOPS'],
      metrics: {},
      sources: [],
      tradingActivity: null,
    };
    const flat = { ...leaderState, positions: [] };
    const analytics = buildCopyMonitorAnalytics(rating, flat, []);
    expect(analytics.alerts.some((a) => a.title.includes('No stop-loss'))).toBe(true);
  });

  it('counts adds from fills', () => {
    const fills: HlFill[] = Array.from({ length: 6 }, (_, i) => ({
      coin: 'ETH',
      side: 'buy',
      px: 1900 - i,
      sz: 1,
      time: i,
      closedPnl: null,
      fee: null,
      dir: 'Open Long',
    }));
    const analytics = buildCopyMonitorAnalytics(null, leaderState, fills);
    expect(analytics.totalAdds).toBeGreaterThanOrEqual(5);
  });

  it('RISK_FLAGS is a non-empty set', () => {
    expect(RISK_FLAGS.size).toBeGreaterThan(0);
  });
});

describe('rated-wallets-service — vendored dataset loads', () => {
  it('loads the bundled rated-wallets.json with wallets', () => {
    const ds = loadRatedWallets();
    expect(ds.count).toBeGreaterThan(0);
    expect(ds.wallets.length).toBe(ds.count);
  });

  it('finds a wallet by address (case-insensitive)', () => {
    const ds = loadRatedWallets();
    const first = ds.wallets[0];
    const found = findRatedWallet(first.address.toUpperCase());
    expect(found?.address).toBe(first.address);
  });

  it('returns null for an unknown address', () => {
    expect(findRatedWallet('0x' + 'f'.repeat(40))).toBeNull();
  });
});
