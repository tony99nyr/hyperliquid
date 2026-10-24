import { describe, expect, it, vi } from 'vitest';
import { buildEventStraddle, prepEventStraddle, type EventStraddlePrepDeps } from '@/lib/ladder/event-straddle-prep-service';
import { runEventPrepCron } from '@/lib/ladder/event-prep-cron-service';

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

  it('creates live, unarmed drafts once per event id and alerts only on creation', async () => {
    const d = deps();
    const first = await prepEventStraddle({ event, now: at('2026-11-06T13:00:00Z') }, d);
    expect('created' in first && first.created).toBe(true);
    expect(d.createPair).toHaveBeenCalledWith(expect.objectContaining({
      eventId: '2026-11-06T13:30:00.000Z',
      legs: [expect.objectContaining({ mode: 'live' }), expect.objectContaining({ mode: 'live' })],
    }));
    expect(d.alertReady).toHaveBeenCalledTimes(1);
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

  it('keeps flag-off cron behaviour as ping only', async () => {
    const ping = vi.fn().mockResolvedValue({ pinged: event.name });
    const prep = vi.fn();
    await runEventPrepCron(at('2026-11-06T13:05:00Z'), false, { ping, prep });
    expect(ping).toHaveBeenCalledOnce();
    expect(prep).not.toHaveBeenCalled();
  });

  it('prepares only inside the due window when the flag is on', async () => {
    const ping = vi.fn();
    const prep = vi.fn().mockResolvedValue({ created: true, ids: ['a', 'b'] });
    await runEventPrepCron(at('2026-11-06T12:59:59Z'), true, { ping, prep });
    expect(prep).not.toHaveBeenCalled();
    await runEventPrepCron(at('2026-11-06T13:05:00Z'), true, { ping, prep });
    expect(prep).toHaveBeenCalledOnce();
    expect(ping).not.toHaveBeenCalled();
  });
});
