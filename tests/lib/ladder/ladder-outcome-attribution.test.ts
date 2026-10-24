/**
 * Fixtures for exchange-fill outcome attribution, shaped on the 2026-10-24 backfill
 * defects (anonymised). Raw rows mirror HL `userFillsByTime`: numeric fields are strings,
 * one oid can carry several partial fills, and one tx hash can carry several fills.
 */
import { describe, it, expect } from 'vitest';
import type { HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { LadderRung, LadderWithRungs } from '@/lib/ladder/ladder-types';
import {
  attributeLadderFills, attributionInvariantFailures, type OutcomeFire,
} from '@/lib/ladder/ladder-outcome-business-logic';
import { resolveLadderOutcome } from '@/lib/skills/ladder-expectancy-business-logic';

const T0 = Date.parse('2026-07-16T23:31:04.856Z');
const HOUR = 3_600_000;

interface RawFill {
  coin: string; side: 'B' | 'A'; px: string; sz: string; time: number; startPosition: string;
  dir: string; closedPnl: string; fee: string; oid: number; tid: number; hash: string;
}

/** Mirrors the service's raw → HlFill normalisation (strings to numbers). */
const toFill = (raw: RawFill): HlFill => ({
  coin: raw.coin, side: raw.side === 'B' ? 'buy' : 'sell', px: Number(raw.px), sz: Number(raw.sz),
  time: raw.time, closedPnl: Number(raw.closedPnl), fee: Number(raw.fee), dir: raw.dir, oid: raw.oid,
  startPosition: Number(raw.startPosition),
});

let tid = 1;
function raw(coin: string, dir: string, sz: string, px: string, time: number, startPosition: string,
  closedPnl: string, fee: string, oid: number, hash = `0x${(tid + 4096).toString(16)}`): RawFill {
  const side = dir === 'Open Long' || dir === 'Close Short' ? 'B' : 'A';
  return { coin, side, px, sz, time, startPosition, dir, closedPnl, fee, oid, tid: tid++, hash };
}

function rung(ladderId: string, seq: number, coin: string, side: 'long' | 'short', action: LadderRung['action']): LadderRung {
  return {
    id: `${ladderId}-r${seq}`, ladderId, seq, coin, side, action, triggerKind: 'price_below', triggerPx: 1,
    triggerMeta: null, sizeCoins: null, reduceFrac: null, riskUsd: 10, stopFrac: 0.02, leverage: 3,
    stopPx: null, targetPx: null, status: 'fired', cloid: null,
  };
}

function ladder(id: string, rungs: LadderRung[]): LadderWithRungs {
  return {
    id, title: id, thesis: null, author: 'operator', mode: 'live', status: 'done', preconditionHash: null,
    ocoGroupId: null, leaderAddress: null, maxTotalNotionalUsd: 500, maxTotalLossUsd: 50, anchorPx: null,
    expiresAt: new Date(T0 + 48 * HOUR).toISOString(), activeFrom: null, armedAt: new Date(T0 - HOUR).toISOString(),
    disarmedAt: null, disarmReason: null, archivedAt: null, expiryAlertAt: null,
    createdAt: new Date(T0 - 2 * HOUR).toISOString(), updatedAt: new Date(T0).toISOString(), rungs,
  };
}

const fire = (ladderId: string, seq: number, firedAt: number): OutcomeFire =>
  ({ ladderId, rungId: `${ladderId}-r${seq}`, status: 'filled', detail: null, firedAt });
const net = (row: { closedPnl: number; fees: number } | undefined) => (row ? row.closedPnl - row.fees : NaN);
const outcome = (item: LadderWithRungs, attribution: ReturnType<typeof attributeLadderFills>, plannedRiskUsd: number) =>
  resolveLadderOutcome({ ladder: item, fireStatuses: ['filled'], hlFills: [], ownerLedger: attribution.byLadder.get(item.id),
    plannedRiskUsd, positionStillOpen: false, now: T0 + 72 * HOUR });

/** A manual ETH round trip whose exit is two fills in ONE tx at the same px and sz. */
function manualTwinExit(): RawFill[] {
  const at = T0 - 30 * HOUR;
  return [
    raw('ETH', 'Open Long', '1.0', '2000.0', at, '0.0', '0.0', '0.70', 100),
    raw('ETH', 'Close Long', '0.5', '2010.0', at + HOUR, '1.0', '5.0', '0.35', 101, '0xshared'),
    raw('ETH', 'Close Long', '0.5', '2010.0', at + HOUR, '0.5', '5.0', '0.35', 101, '0xshared'),
  ];
}

describe('ladder outcome attribution: flat-coin ladders (trend-follow shape)', () => {
  const trend = ladder('trend', [rung('trend', 1, 'ETH', 'long', 'open')]);
  const fires = [fire('trend', 1, T0)];
  const own = [
    raw('ETH', 'Open Long', '0.0475', '2523.2', T0 + 2_113, '0.0', '0.0', '0.05', 200),
    raw('ETH', 'Close Long', '0.0475', '2451.1', T0 + 33 * HOUR + 7_411, '0.0475', '-3.42', '0.05', 201),
  ];

  it('closes the ladder when every fill is present and the account is flat', () => {
    const result = attributeLadderFills([trend], fires, [...manualTwinExit(), ...own].map(toFill).reverse(),
      { finalPositions: new Map() });
    expect(attributionInvariantFailures(result)).toEqual([]);
    expect(result.byLadder.get('trend')?.openSize).toBeCloseTo(0, 9);
    expect(net(result.byLadder.get('trend'))).toBeCloseTo(-3.52, 6);
    expect(outcome(trend, result, 30).outcome).toBe('lost');
  });

  it('flags the phantom lot a dropped shared-hash fill leaves behind', () => {
    const fills = [...manualTwinExit().slice(0, 2), ...own].map(toFill);
    const result = attributeLadderFills([trend], fires, fills, { finalPositions: new Map() });
    expect(result.byLadder.get('trend')?.openSize).toBeGreaterThan(0);
    const failures = attributionInvariantFailures(result);
    expect(result.continuityBreaks.length).toBeGreaterThan(0);
    expect(failures.some((item) => item.startsWith('trend holds'))).toBe(true);
    expect(failures.some((item) => item.startsWith('ETH: lots'))).toBe(true);
  });
});

describe('ladder outcome attribution: event-straddle legs', () => {
  it('Retail Sales short: entry +2.0s owns its lot; a management ladder reduce stays with it', () => {
    const straddle = ladder('rs-short', [rung('rs-short', 1, 'ETH', 'short', 'open'),
      rung('rs-short', 2, 'ETH', 'short', 'reduce'), rung('rs-short', 3, 'ETH', 'short', 'reduce')]);
    const runner = ladder('runner', [rung('runner', 1, 'ETH', 'short', 'reduce')]);
    const fills = [...manualTwinExit(), raw('ETH', 'Open Short', '0.2191', '1862.8', T0 + 2_004, '0.0', '0.0', '0.18', 300),
      raw('ETH', 'Close Short', '0.0744', '1838.1', T0 + 6 * HOUR + 1_031, '-0.2191', '1.84', '0.06', 301),
      raw('ETH', 'Close Short', '0.0723', '1824.2', T0 + 6.5 * HOUR + 950, '-0.1447', '2.79', '0.06', 302),
      raw('ETH', 'Close Short', '0.0362', '1845.2', T0 + 32.75 * HOUR + 1_190, '-0.0724', '0.64', '0.03', 303),
      raw('ETH', 'Close Short', '0.0362', '1863.5', T0 + 42.9 * HOUR, '-0.0362', '-0.03', '0.03', 299)].map(toFill);
    const fires = [fire('rs-short', 1, T0), fire('rs-short', 2, T0 + 6 * HOUR), fire('rs-short', 3, T0 + 6.5 * HOUR),
      fire('runner', 1, T0 + 32.75 * HOUR)];
    const result = attributeLadderFills([straddle, runner], fires, fills, { finalPositions: new Map() });
    expect(attributionInvariantFailures(result)).toEqual([]);
    expect(result.byLadder.get('rs-short')?.entrySize).toBeCloseTo(0.2191, 9);
    expect(result.byLadder.get('runner')?.entrySize).toBe(0);
    expect(net(result.byLadder.get('rs-short'))).toBeCloseTo(4.88, 6);
    expect(outcome(straddle, result, 44).outcome).toBe('won');
  });

  it('PPI long: a resting-stop exit closes the lot as a loss, not open', () => {
    const leg = ladder('ppi-long', [rung('ppi-long', 1, 'ETH', 'long', 'open')]);
    const fills = [raw('ETH', 'Open Long', '0.1784', '1931.2', T0 + 1_874, '0.0', '0.0', '0.16', 400),
      raw('ETH', 'Close Long', '0.1784', '1909.2', T0 + 3.6 * HOUR, '0.1784', '-3.92', '0.15', 401)].map(toFill);
    const result = attributeLadderFills([leg], [fire('ppi-long', 1, T0)], fills, { finalPositions: new Map() });
    expect(attributionInvariantFailures(result)).toEqual([]);
    expect(net(result.byLadder.get('ppi-long'))).toBeCloseTo(-4.23, 6);
    expect(outcome(leg, result, 40).outcome).toBe('lost');
  });

  it('FOMC short: half reduced by fire, half by the earlier-oid stop; a prior manual trade does not leak', () => {
    const leg = ladder('fomc-short', [rung('fomc-short', 1, 'BTC', 'short', 'open'), rung('fomc-short', 2, 'BTC', 'short', 'reduce')]);
    const fills = [raw('BTC', 'Open Long', '0.00017', '61000.0', T0 - 9 * HOUR, '0.0', '0.0', '0.01', 500),
      raw('BTC', 'Close Long', '0.00017', '61500.0', T0 - 8 * HOUR, '0.00017', '0.085', '0.01', 501),
      raw('BTC', 'Open Short', '0.04251', '63508.0', T0 + 2_033, '0.0', '0.0', '1.21', 600),
      raw('BTC', 'Close Short', '0.02125', '63952.0', T0 + 1.75 * HOUR, '-0.04251', '-9.44', '0.61', 620),
      raw('BTC', 'Close Short', '0.02126', '64213.0', T0 + 5.25 * HOUR, '-0.02126', '-14.99', '0.61', 601)].map(toFill);
    const result = attributeLadderFills([leg], [fire('fomc-short', 1, T0), fire('fomc-short', 2, T0 + 1.75 * HOUR)], fills,
      { finalPositions: new Map() });
    expect(attributionInvariantFailures(result)).toEqual([]);
    expect(net(result.byLadder.get('fomc-short'))).toBeCloseTo(-26.86, 6);
    expect(net(result.manual.get('BTC'))).toBeCloseTo(0.065, 6);
    expect(outcome(leg, result, 290).outcome).toBe('lost');
  });

  it('Jackson Hole short: four partials of one oid all belong to the fire', () => {
    const leg = ladder('jh-short', [rung('jh-short', 1, 'BTC', 'short', 'open')]);
    const at = T0 + 1_912;
    const fills = [raw('BTC', 'Open Short', '0.00049', '78358.0', at, '0.0', '0.0', '0.02', 700, '0xjh'),
      raw('BTC', 'Open Short', '0.00014', '78358.0', at, '-0.00049', '0.0', '0.004', 700, '0xjh'),
      raw('BTC', 'Open Short', '0.00016', '78354.0', at, '-0.00063', '0.0', '0.006', 700, '0xjh'),
      raw('BTC', 'Open Short', '0.02371', '78354.0', at, '-0.00079', '0.0', '0.84', 700, '0xjh'),
      raw('BTC', 'Close Short', '0.0245', '77544.0', T0 + 21 * HOUR, '-0.0245', '19.65', '0.85', 701)].map(toFill);
    const result = attributeLadderFills([leg], [fire('jh-short', 1, T0)], fills, { finalPositions: new Map() });
    expect(attributionInvariantFailures(result)).toEqual([]);
    expect(result.byLadder.get('jh-short')?.entrySize).toBeCloseTo(0.0245, 9);
    expect(result.unmatchedEntryCount).toBe(0);
    expect(net(result.byLadder.get('jh-short'))).toBeCloseTo(17.93, 6);
  });
});

describe('ladder outcome attribution: end-state invariants', () => {
  const leg = ladder('live-long', [rung('live-long', 1, 'ETH', 'long', 'open')]);
  const fills = [raw('ETH', 'Open Long', '0.0086', '2723.4', T0 + 2_010, '0.0', '0.0', '0.01', 800, '0xpart'),
    raw('ETH', 'Open Long', '0.0354', '2723.5', T0 + 2_010, '0.0086', '0.0', '0.04', 800, '0xpart')].map(toFill);
  const run = (finalPositions?: Map<string, number>) =>
    attributeLadderFills([leg], [fire('live-long', 1, T0)], fills, finalPositions ? { finalPositions } : {});

  it('accepts an open ladder only when the account holds the same-sign position', () => {
    const result = run(new Map([['ETH', 0.044]]));
    expect(attributionInvariantFailures(result)).toEqual([]);
    expect(outcome(leg, result, 30).outcome).toBe('open');
  });

  it('rejects an open ladder on a flat account', () => {
    const failures = attributionInvariantFailures(run(new Map()));
    expect(failures.some((item) => item.startsWith('live-long holds'))).toBe(true);
  });

  it('rejects an open ladder against an opposite-sign account', () => {
    const failures = attributionInvariantFailures(run(new Map([['ETH', -0.044]])));
    expect(failures.some((item) => item.startsWith('live-long holds'))).toBe(true);
    expect(failures.some((item) => item.startsWith('ETH: lots'))).toBe(true);
  });

  it('sums open lots to the final account position per coin', () => {
    const result = run(new Map([['ETH', 0.044], ['BTC', 0]]));
    expect(result.inventory).toEqual([
      expect.objectContaining({ coin: 'BTC', lotPosition: 0, accountPosition: 0, passed: true }),
      expect.objectContaining({ coin: 'ETH', accountPosition: 0.044, passed: true }),
    ]);
    expect(result.inventory[1].lotPosition).toBeCloseTo(0.044, 9);
  });
});
