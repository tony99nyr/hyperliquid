import { describe, expect, it, vi } from 'vitest';
import { buildEventStraddle, prepEventStraddle, type EventStraddlePrepDeps } from '@/lib/ladder/event-straddle-prep-service';
import { runEventPrepCron } from '@/lib/ladder/event-prep-cron-service';
import type { UpcomingEvent } from '@/lib/skills/event-calendar-business-logic';

const event = { name: 'NFP (Oct data)', atIso: '2026-11-06T13:30:00Z', straddleCoin: 'BTC' };
const at = (iso: string) => Date.parse(iso);

function deps(): EventStraddlePrepDeps {
  return {
    getMid: vi.fn().mockResolvedValue(100_000),
    createPair: vi.fn().mockResolvedValue({ created: true, ids: ['long-id', 'short-id'] }),
    alertReady: vi.fn().mockResolvedValue(undefined),
  };
}

describe('event straddle preparation', () => {
  it('uses the print instant as the key and keeps both legs draft-only', () => {
    const now = at('2026-11-06T13:00:00Z');
    const first = buildEventStraddle({ event, now }, 100_000, '00000000-0000-0000-0000-000000000001');
    const renamed = buildEventStraddle({ event: { ...event, name: 'Payrolls' }, now }, 100_000, '00000000-0000-0000-0000-000000000002');
    expect(first.eventId).toBe(renamed.eventId);
    expect(first.legs.map((leg) => leg.mode)).toEqual(['live', 'live']);
    expect(first.legs.map((leg) => leg.rungs.length)).toEqual([6, 6]);
    expect(first.legs.every((leg) => !('status' in leg))).toBe(true);
  });

  it('sizes each leg at the standing $12 when the caller (the cron) gives no risk', () => {
    const now = at('2026-11-06T13:00:00Z');
    const fromCron = buildEventStraddle({ event, now }, 100_000, '00000000-0000-0000-0000-000000000001');
    expect(fromCron.legs.map((leg) => leg.rungs[0].riskUsd)).toEqual([12, 12]);
    // Caps scale with the risk: notional = risk / stopFrac, +15% headroom.
    for (const leg of fromCron.legs) {
      const open = leg.rungs[0];
      expect(leg.maxTotalNotionalUsd).toBe(Math.ceil((12 / open.stopFrac!) * 1.15));
    }
    const manual = buildEventStraddle({ event, now, riskUsd: 4 }, 100_000, '00000000-0000-0000-0000-000000000002');
    expect(manual.legs.map((leg) => leg.rungs[0].riskUsd)).toEqual([4, 4]);
  });

  it('closes the entry gate 120 minutes after the print and keeps the 24h expiry for management', () => {
    const now = at('2026-11-06T13:00:00Z');
    const pair = buildEventStraddle({ event, now }, 100_000, '00000000-0000-0000-0000-000000000001');
    const deadline = at('2026-11-06T15:30:00Z');
    expect(pair.entryDeadlineMs).toBe(deadline);
    for (const leg of pair.legs) {
      expect(leg.expiresAtMs).toBe(at('2026-11-07T13:30:00Z'));
      expect(leg.rungs[0]).toMatchObject({ action: 'open', triggerMeta: { entryDeadlineMs: deadline } });
      // Only the entry carries the deadline: an exit must never be gated by it.
      expect(leg.rungs.slice(1).every((r) => r.triggerMeta?.entryDeadlineMs === undefined)).toBe(true);
      expect(leg.thesis).toContain('entry gate closes at print+120min (2026-11-06T15:30:00.000Z)');
    }
  });

  it('creates live, unarmed drafts once per event id and alerts only on creation', async () => {
    const d = deps();
    const first = await prepEventStraddle({ event, now: at('2026-11-06T13:00:00Z') }, d);
    expect('created' in first && first.created).toBe(true);
    expect(d.createPair).toHaveBeenCalledWith(expect.objectContaining({
      eventId: '2026-11-06T13:30:00.000Z',
      legs: [expect.objectContaining({ mode: 'live' }), expect.objectContaining({ mode: 'live' })],
    }));
    expect(d.alertReady).toHaveBeenCalledTimes(1);
    expect(d.alertReady).toHaveBeenCalledWith(expect.objectContaining({ entryDeadlineMs: at('2026-11-06T15:30:00Z') }));
    vi.mocked(d.createPair).mockResolvedValueOnce({ created: false, ids: ['long-id', 'short-id'] });
    const second = await prepEventStraddle({ event, now: at('2026-11-06T13:01:00Z') }, d);
    expect('created' in second && second.created).toBe(false);
    expect(d.alertReady).toHaveBeenCalledTimes(1);
  });

  it('does not fetch a reference outside the T-30 to print window', async () => {
    const d = deps();
    await expect(prepEventStraddle({ event, now: at('2026-11-06T12:59:59Z') }, d)).rejects.toThrow('outside prep window');
    await expect(prepEventStraddle({ event, now: at('2026-11-06T13:30:00Z') }, d)).rejects.toThrow('outside prep window');
    expect(d.getMid).not.toHaveBeenCalled();
  });

  it('permits a manual dry preview before the prep window without creating drafts', async () => {
    const d = deps();
    await expect(prepEventStraddle({ event, now: at('2026-11-05T12:00:00Z'), dry: true }, d)).resolves.toEqual({ dry: true });
    expect(d.createPair).not.toHaveBeenCalled();
  });

  // Injected `due` keeps these hermetic: the real calendar's entries get pruned at
  // retros, so a cron test pinned to a live calendar date is a time-bomb.
  const dueEvent = (now: number): UpcomingEvent => ({
    ...event,
    atMs: at(event.atIso),
    msOut: at(event.atIso) - now,
    daysOut: 0,
    hoursOut: 0,
    prepLeadMs: 30 * 60_000,
    prepDue: true,
  });

  it('keeps flag-off cron behaviour as ping only', async () => {
    const ping = vi.fn().mockResolvedValue({ pinged: event.name });
    const prep = vi.fn();
    await runEventPrepCron(at('2026-11-06T13:05:00Z'), false, { ping, prep, due: dueEvent });
    expect(ping).toHaveBeenCalledOnce();
    expect(prep).not.toHaveBeenCalled();
  });

  it('prepares only inside the due window when the flag is on', async () => {
    const ping = vi.fn();
    const prep = vi.fn().mockResolvedValue({ created: true, ids: ['a', 'b'] });
    await runEventPrepCron(at('2026-11-06T12:59:59Z'), true, { ping, prep, due: () => null });
    expect(prep).not.toHaveBeenCalled();
    await runEventPrepCron(at('2026-11-06T13:05:00Z'), true, { ping, prep, due: dueEvent });
    expect(prep).toHaveBeenCalledOnce();
    expect(ping).not.toHaveBeenCalled();
  });
});
