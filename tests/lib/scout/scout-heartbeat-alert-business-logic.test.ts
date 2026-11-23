import { describe, it, expect } from 'vitest';
import {
  heartbeatVerdict,
  staleMessage,
  STALE_AFTER_MS,
  REALERT_COOLDOWN_MS,
  shouldJudge,
} from '@/lib/scout/scout-heartbeat-alert-business-logic';

const NOW = 1_784_300_000_000;
const row = (over: Partial<{ source: string; lastTickAtMs: number; staleAlertedAtMs: number | null }> = {}) => ({
  source: 'scout-cycle',
  lastTickAtMs: NOW - 10 * 60 * 1000,
  staleAlertedAtMs: null,
  ...over,
});

describe('heartbeatVerdict', () => {
  it('fresh rows are ok — including fresh-after-alert (no recovery flapping: the stamp survives)', () => {
    expect(heartbeatVerdict(row(), NOW)).toBe('ok');
    expect(heartbeatVerdict(row({ staleAlertedAtMs: NOW - 3600e3 }), NOW)).toBe('ok');
  });

  it('a crash-looping daemon (flap: fresh tick, stale again) cannot bypass the cooldown', () => {
    const stalePaged = row({ lastTickAtMs: NOW - 2 * 3600e3, staleAlertedAtMs: NOW - 3 * 3600e3 });
    // fresh blip did NOT clear the stamp → still quiet inside the 6h cooldown
    expect(heartbeatVerdict(stalePaged, NOW)).toBe('stale-quiet');
  });

  it('pages once when stale, stays quiet within the cooldown, re-pages after', () => {
    const stale = row({ lastTickAtMs: NOW - STALE_AFTER_MS['scout-cycle'] - 60_000 });
    expect(heartbeatVerdict(stale, NOW)).toBe('stale-page');
    expect(heartbeatVerdict({ ...stale, staleAlertedAtMs: NOW - 3600e3 }, NOW)).toBe('stale-quiet');
    expect(heartbeatVerdict({ ...stale, staleAlertedAtMs: NOW - REALERT_COOLDOWN_MS - 1 }, NOW)).toBe('stale-page');
  });

  it('per-source thresholds: producer pages at 30min, consumer only at 90min', () => {
    const at45min = NOW - 45 * 60 * 1000;
    expect(heartbeatVerdict(row({ source: 'scout-watch', lastTickAtMs: at45min }), NOW)).toBe('stale-page');
    expect(heartbeatVerdict(row({ source: 'scout-cycle', lastTickAtMs: at45min }), NOW)).toBe('ok');
  });

  it('unknown sources are never paged', () => {
    expect(heartbeatVerdict(row({ source: 'mystery', lastTickAtMs: 0 }), NOW)).toBe('ok');
  });
});

describe('staleMessage', () => {
  it('names the component and the silence duration', () => {
    const msg = staleMessage(row({ lastTickAtMs: NOW - 16 * 3600e3 }), NOW);
    expect(msg).toContain('SCOUT-CYCLE');
    expect(msg).toContain('16.0h');
    expect(msg).toContain('decision engine');
  });
});

describe('staleMessage routes the operator to the RIGHT system (review 10-03)', () => {
  const row = (source: string) => ({ source, lastTickAtMs: 0, staleAlertedAtMs: null });
  it('a dead reconcile cron pages as a LEDGER problem, not a scout problem', () => {
    const m = staleMessage(row('reconcile'), 3_600_000);
    expect(m).toMatch(/RECONCILE CRON/);
    expect(m).toMatch(/poker/i);
    expect(m).not.toMatch(/scout-repair/);
  });
  it('a dead auto-exit cron pages as a RISK-NET problem', () => {
    const m = staleMessage(row('auto-exit-cron'), 3_600_000);
    expect(m).toMatch(/AUTO-EXIT CRON/);
    expect(m).toMatch(/NO automated risk net/);
  });
  it('scout sources keep the scout wording', () => {
    expect(staleMessage(row('scout-watch'), 3_600_000)).toMatch(/scout-repair runbook/);
  });
});

describe('reconcile-ok: page on a long degraded run, not on one skip (2026-11-22)', () => {
  const MIN = 60_000;
  it('a degraded route (reconcile fresh, reconcile-ok 31 min old) pages', () => {
    expect(shouldJudge('reconcile-ok', true, NOW - 5 * MIN, NOW)).toBe(true);
    expect(heartbeatVerdict(row({ source: 'reconcile-ok', lastTickAtMs: NOW - 31 * MIN }), NOW)).toBe('stale-page');
  });
  it('one transient skip does not page: the last healthy run is minutes old', () => {
    expect(heartbeatVerdict(row({ source: 'reconcile-ok', lastTickAtMs: NOW - 12 * MIN }), NOW)).toBe('ok');
  });
  it('a dead route pages once, as RECONCILE CRON SILENT, not also as degraded', () => {
    expect(shouldJudge('reconcile-ok', true, NOW - 45 * MIN, NOW)).toBe(false);
    expect(shouldJudge('reconcile-ok', true, null, NOW)).toBe(false);
  });
  it('an absent reconcile-ok row (before the first healthy run after deploy) does not page', () => {
    expect(shouldJudge('reconcile-ok', false, NOW - 5 * MIN, NOW)).toBe(false);
  });
  it('other sources are always judged, absent or not', () => {
    expect(shouldJudge('reconcile', false, null, NOW)).toBe(true);
  });
  it('the page names the degraded state and carries the skip reason', () => {
    const m = staleMessage(row({ source: 'reconcile-ok', lastTickAtMs: NOW - 2 * 3600e3 }), NOW, 'reconcile SKIPPED (hl read failed)');
    expect(m).toMatch(/RECONCILE DEGRADED 2\.0h/);
    expect(m).toContain('hl read failed');
  });
});
