import { describe, expect, it } from 'vitest';
import {
  canSkipAutoExitPoke,
  nasCoversProdCrons,
  reconcileRanCompletely,
  tickUtcMinute,
  NAS_FRESH_MS,
  NAS_POKE_FAILED,
  PROBE_WINDOW_MINUTES,
} from '@/lib/auto-exit/cron-poke-business-logic';

describe('canSkipAutoExitPoke', () => {
  const flat = { reconcileComplete: true, liveOpenPositions: 0, lastAutoExitStatus: 'ok', utcMinute: 20 };

  it('skips only when the reconcile ran, the book is confirmed flat and the last poke did not fail', () => {
    expect(canSkipAutoExitPoke(flat)).toBe(true);
  });

  it('pokes while a live position is open', () => {
    expect(canSkipAutoExitPoke({ ...flat, liveOpenPositions: 1 })).toBe(false);
  });

  it('pokes when a read failed or the reconcile did not run completely', () => {
    expect(canSkipAutoExitPoke({ ...flat, liveOpenPositions: null })).toBe(false);
    expect(canSkipAutoExitPoke({ ...flat, reconcileComplete: false })).toBe(false);
    expect(canSkipAutoExitPoke({ ...flat, lastAutoExitStatus: null })).toBe(false);
  });

  it('keeps poking after a failed poke, so a broken route never gets a fresh ok stamp', () => {
    expect(canSkipAutoExitPoke({ ...flat, lastAutoExitStatus: NAS_POKE_FAILED })).toBe(false);
  });

  it('pokes on the first tick of each hour as a probe', () => {
    expect(canSkipAutoExitPoke({ ...flat, utcMinute: 0 })).toBe(false);
    expect(canSkipAutoExitPoke({ ...flat, utcMinute: PROBE_WINDOW_MINUTES })).toBe(true);
  });
});

describe('reconcileRanCompletely', () => {
  const body = { ok: true, skipped: false, backfill: { skipped: false } };

  it('is true for a 2xx run where nothing skipped', () => {
    expect(reconcileRanCompletely(true, body)).toBe(true);
  });

  it('is false when the reconcile or the backfill skipped, or the poke failed', () => {
    expect(reconcileRanCompletely(true, { ...body, skipped: true })).toBe(false);
    expect(reconcileRanCompletely(true, { ...body, backfill: { skipped: true } })).toBe(false);
    // A cached-fills read or failed rows must not let the NAS skip the auto-exit poke.
    expect(reconcileRanCompletely(true, { ...body, backfill: { skipped: false, incomplete: 'HL read failed' } })).toBe(false);
    expect(reconcileRanCompletely(false, body)).toBe(false);
    expect(reconcileRanCompletely(true, null)).toBe(false);
  });
});

describe('nasCoversProdCrons', () => {
  const now = 1_000_000_000;
  const row = (source: string, detail: string, status = 'ok') => ({ source, lastTickAtMs: now - 60_000, status, detail });

  it('is true when the NAS stamped both heartbeats ok recently', () => {
    expect(nasCoversProdCrons([row('reconcile', 'reconcile ran via nas'), row('auto-exit-cron', 'skipped via nas-local')], now)).toBe(true);
  });

  it('is false when the last stamp came from the office box', () => {
    expect(nasCoversProdCrons([row('reconcile', 'via nas'), row('auto-exit-cron', 'ran via local')], now)).toBe(false);
  });

  it('is false when the NAS marked a failed poke, and true for a degraded route run', () => {
    expect(nasCoversProdCrons([row('reconcile', 'via nas', NAS_POKE_FAILED), row('auto-exit-cron', 'via nas')], now)).toBe(false);
    expect(nasCoversProdCrons([row('reconcile', 'via nas', 'degraded'), row('auto-exit-cron', 'via nas')], now)).toBe(true);
  });

  it('is false when a heartbeat is stale or missing', () => {
    const stale = { source: 'auto-exit-cron', lastTickAtMs: now - NAS_FRESH_MS - 1, status: 'ok', detail: 'via nas' };
    expect(nasCoversProdCrons([row('reconcile', 'via nas'), stale], now)).toBe(false);
    expect(nasCoversProdCrons([row('reconcile', 'via nas')], now)).toBe(false);
  });
});

describe('tickUtcMinute', () => {
  it('reads the zero-padded tick-start minute and falls back on anything else', () => {
    expect(tickUtcMinute('08', 30)).toBe(8);
    expect(tickUtcMinute('', 30)).toBe(30);
    expect(tickUtcMinute(undefined, 30)).toBe(30);
    expect(tickUtcMinute('75', 30)).toBe(30);
    expect(tickUtcMinute('5x', 30)).toBe(30);
  });
});
