import { describe, it, expect } from 'vitest';
import {
  heartbeatVerdict,
  staleMessage,
  STALE_AFTER_MS,
  REALERT_COOLDOWN_MS,
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
