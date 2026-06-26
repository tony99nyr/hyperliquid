import { describe, it, expect } from 'vitest';
import {
  parseVaultSnapshot,
  buildVaultSnapshotRow,
  peakToTroughDrop,
  vaultReturnSince,
} from '@/lib/scout/vault-snapshot-business-logic';

const NOW = Date.UTC(2026, 5, 26); // fixed clock
const DAY = 86_400_000;

// A trimmed but shape-faithful vaultDetails payload (HL sends numbers as strings,
// portfolio is [label, {accountValueHistory,…}] pairs of varying length).
function hlpRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Hyperliquidity Provider (HLP)',
    vaultAddress: '0xDFC24b077bc1425AD1DEA75bcb6f8158E10DF303',
    leader: '0xAbC0000000000000000000000000000000000001',
    apr: 0.124,
    leaderFraction: 0.07,
    portfolio: [
      ['week', { accountValueHistory: [[NOW - 2 * DAY, '1000'], [NOW, '1010']], pnlHistory: [] }],
      // allTime = the longest series → picked. accountValue is flow-polluted; the
      // honest drawdown comes from the cumulative pnlHistory.
      ['allTime', {
        accountValueHistory: [
          [NOW - 30 * DAY, '1000'],
          [NOW - 20 * DAY, '1200'], // peak NAV (the drawdown denominator)
          [NOW - 10 * DAY, '1080'],
          [NOW, '1150'],
        ],
        // cumulative PnL: peaks at 200, troughs at 80 → a $120 drop
        pnlHistory: [
          [NOW - 30 * DAY, '0'],
          [NOW - 20 * DAY, '200'],
          [NOW - 10 * DAY, '80'],
          [NOW, '150'],
        ],
      }],
    ],
    ...over,
  };
}

describe('parseVaultSnapshot', () => {
  it('extracts NAV (latest), apr, leader fraction, age, drawdown from the longest window', () => {
    const s = parseVaultSnapshot(hlpRaw(), { now: NOW, kind: 'hlp' });
    expect(s.kind).toBe('hlp');
    expect(s.vaultAddress).toBe('0xdfc24b077bc1425ad1dea75bcb6f8158e10df303'); // lowercased
    expect(s.navUsd).toBe(1150); // last point of the allTime series, not the week series
    expect(s.aprAnnual).toBeCloseTo(0.124, 6);
    expect(s.leaderFraction).toBeCloseTo(0.07, 6);
    expect(s.ageDays).toBeCloseTo(30, 6); // earliest allTime point
    // flow-free: $120 PnL drop / $1200 peak NAV = 10% (NOT the account-value dip)
    expect(s.maxDrawdownPct).toBeCloseTo(120 / 1200, 6);
  });

  it('is defensive: missing portfolio / fields → nulls, never throws', () => {
    const s = parseVaultSnapshot({ name: 'x' }, { now: NOW, kind: 'operator', fallbackAddress: '0xFEED' });
    expect(s.navUsd).toBeNull();
    expect(s.aprAnnual).toBeNull();
    expect(s.maxDrawdownPct).toBeNull();
    expect(s.ageDays).toBeNull();
    expect(s.vaultAddress).toBe('0xfeed'); // fell back + lowercased
    expect(s.kind).toBe('operator');
  });

  it('buildVaultSnapshotRow maps to the insert shape with ISO timestamp', () => {
    const row = buildVaultSnapshotRow(parseVaultSnapshot(hlpRaw(), { now: NOW, kind: 'hlp' }));
    expect(row.vault_address).toBe('0xdfc24b077bc1425ad1dea75bcb6f8158e10df303');
    expect(row.nav_usd).toBe(1150);
    expect(row.kind).toBe('hlp');
    expect(row.fetched_at).toBe(new Date(NOW).toISOString());
  });
});

describe('peakToTroughDrop', () => {
  it('null below 2 points; 0 on a monotonic rise; largest $ drop otherwise', () => {
    expect(peakToTroughDrop([])).toBeNull();
    expect(peakToTroughDrop([[0, 100]])).toBeNull();
    expect(peakToTroughDrop([[0, 100], [1, 110], [2, 120]])).toBe(0);
    expect(peakToTroughDrop([[0, 0], [1, 200], [2, 80]])).toBe(120); // cum-PnL peak 200 → 80
  });
});

describe('vaultReturnSince', () => {
  const DAY2 = 86_400_000;
  // cumPnl rises 100→150 over the window; AUM ≈ 1000 at the start → 5% return.
  const raw = {
    portfolio: [
      ['allTime', {
        accountValueHistory: [
          [NOW - 40 * DAY2, '900'],
          [NOW - 30 * DAY2, '1000'], // AUM at lookback start
          [NOW, '1050'],
        ],
        pnlHistory: [
          [NOW - 40 * DAY2, '80'],
          [NOW - 30 * DAY2, '100'], // pnl at lookback start
          [NOW, '150'],            // +50 since start
        ],
      }],
    ],
  };

  it('return = ΔcumPnl / AUM_at_start, flow-free (50 / 1000 = 5%)', () => {
    const r = vaultReturnSince(raw, NOW - 30 * DAY2);
    expect(r.returnFrac).toBeCloseTo(50 / 1000, 6);
    expect(r.navUsd).toBe(1050);
    expect(r.spanDays).toBeCloseTo(30, 6);
  });

  it('null when history is too thin or AUM non-positive', () => {
    expect(vaultReturnSince({ portfolio: [] }, NOW).returnFrac).toBeNull();
    expect(vaultReturnSince({}, NOW).returnFrac).toBeNull();
  });
});
