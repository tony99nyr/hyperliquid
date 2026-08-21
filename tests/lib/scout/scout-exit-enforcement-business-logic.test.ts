import { describe, it, expect } from 'vitest';
import {
  stopHit,
  laneMechanicalExit,
  decideEnforcedExit,
  LEADER_FOLLOW_TIME_STOP_HOURS,
  type EnforceablePosition,
} from '@/lib/scout/scout-exit-enforcement-business-logic';
import type { HtfTrendRead } from '@/lib/scout/htf-trend-signal-business-logic';
import type { CompressionRead } from '@/lib/scout/compression-squeeze-signal-business-logic';

const NOW = 1_787_000_000_000;
const H = 3_600_000;

const pos = (over: Partial<EnforceablePosition> = {}): EnforceablePosition => ({
  sessionId: 's1',
  coin: 'ETH',
  side: 'long',
  lane: 'htf-trend',
  entryPx: 2260,
  stopPx: 2132,
  openedAtMs: NOW - 24 * H,
  ...over,
});

const htfRead = (over: Partial<HtfTrendRead> = {}): HtfTrendRead => ({
  latestClose: 2300,
  don20High: 2310,
  don20Low: 1900,
  don10High: 2280,
  don10Low: 2000,
  atr: 60,
  breakout: null,
  ...over,
});

const compRead = (over: Partial<CompressionRead> = {}): CompressionRead => ({
  latestClose: 100,
  bbMid: 98,
  bbw: 0.05,
  bbwPctile: 0.5,
  inSqueeze: false,
  barsSinceSqueeze: null,
  don20High: 105,
  don20Low: 95,
  breakout: null,
  ...over,
});

describe('stopHit — the one check that needs only the mark', () => {
  it('fires when the mark crosses the stop, both sides', () => {
    expect(stopHit(pos(), 2131)?.reason).toBe('stop-hit');
    expect(stopHit(pos(), 2132)?.reason).toBe('stop-hit'); // at the stop = hit
    expect(stopHit(pos(), 2133)).toBeNull();
    const short = pos({ side: 'short', stopPx: 2400 });
    expect(stopHit(short, 2401)?.reason).toBe('stop-hit');
    expect(stopHit(short, 2399)).toBeNull();
  });

  it('never fires without a stored stop or a valid mark (legacy rows hold)', () => {
    expect(stopHit(pos({ stopPx: null }), 100)).toBeNull();
    expect(stopHit(pos(), 0)).toBeNull();
    expect(stopHit(pos(), NaN)).toBeNull();
  });
});

describe('laneMechanicalExit — frozen rules only, null-safe', () => {
  it('htf-trend: exits a long on a daily close below the 10d low; holds otherwise', () => {
    const d = laneMechanicalExit(pos(), { htf: htfRead({ latestClose: 1999 }) }, NOW);
    expect(d?.reason).toBe('htf-channel-exit');
    expect(laneMechanicalExit(pos(), { htf: htfRead({ latestClose: 2001 }) }, NOW)).toBeNull();
  });

  it('htf-trend: a MISSING scan never exits (blind closes are acts, not safeties)', () => {
    expect(laneMechanicalExit(pos(), {}, NOW)).toBeNull();
    expect(laneMechanicalExit(pos(), { htf: null }, NOW)).toBeNull();
  });

  it('compression-straddle: exits on the 4h close back through the BB mid', () => {
    const p = pos({ lane: 'compression-straddle' });
    expect(laneMechanicalExit(p, { compression: compRead({ latestClose: 97 }) }, NOW)?.reason).toBe('compression-mid-exit');
    expect(laneMechanicalExit(p, { compression: compRead({ latestClose: 99 }) }, NOW)).toBeNull();
  });

  it('leader-follow: exits when the leader is gone; holds on an UNKNOWN feed', () => {
    const p = pos({ lane: 'leader-follow', openedAtMs: NOW - 2 * H });
    expect(laneMechanicalExit(p, { leaderFollow: { leaderStillHolding: false } }, NOW)?.reason).toBe('leader-gone');
    expect(laneMechanicalExit(p, { leaderFollow: { leaderStillHolding: true } }, NOW)).toBeNull();
    expect(laneMechanicalExit(p, { leaderFollow: { leaderStillHolding: null } }, NOW)).toBeNull();
  });

  it('leader-follow: the 72h time-stop fires on age alone', () => {
    const p = pos({ lane: 'leader-follow', openedAtMs: NOW - (LEADER_FOLLOW_TIME_STOP_HOURS + 1) * H });
    expect(laneMechanicalExit(p, { leaderFollow: { leaderStillHolding: true } }, NOW)?.reason).toBe('leader-time-stop');
  });

  it('unknown/passive/legacy lanes get no mechanical exit (stop-only coverage)', () => {
    for (const lane of ['vault', 'carry', 'breakdown-short', null]) {
      expect(laneMechanicalExit(pos({ lane }), { htf: htfRead({ latestClose: 1 }) }, NOW)).toBeNull();
    }
  });
});

describe('decideEnforcedExit — stop first, then the lane rule', () => {
  it('the stop wins even when the lane exit also fires', () => {
    const d = decideEnforcedExit(pos(), 2100, { htf: htfRead({ latestClose: 1999 }) }, NOW);
    expect(d?.reason).toBe('stop-hit');
  });

  it('falls through to the lane exit when the stop holds, and to null when both hold', () => {
    expect(decideEnforcedExit(pos(), 2200, { htf: htfRead({ latestClose: 1999 }) }, NOW)?.reason).toBe('htf-channel-exit');
    expect(decideEnforcedExit(pos(), 2200, { htf: htfRead({ latestClose: 2100 }) }, NOW)).toBeNull();
  });

  it('a null mark skips the stop check but still allows the lane exit', () => {
    expect(decideEnforcedExit(pos(), null, { htf: htfRead({ latestClose: 1999 }) }, NOW)?.reason).toBe('htf-channel-exit');
  });
});
