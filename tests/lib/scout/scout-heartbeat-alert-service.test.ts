import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: vi.fn() }));
vi.mock('@/lib/infrastructure/notify/discord-notify', () => ({ sendDiscord: vi.fn(async () => true) }));

import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import { checkScoutHeartbeats } from '@/lib/scout/scout-heartbeat-alert-service';

const NOW = 1_784_300_000_000;
const MIN = 60_000;
const iso = (minAgo: number) => new Date(NOW - minAgo * MIN).toISOString();
const fresh = (source: string) => ({ source, last_tick_at: iso(1), stale_alerted_at: null, detail: 'ok' });

let upserts: Array<{ row: Record<string, unknown>; opts: Record<string, unknown> }>;
let updates: Array<{ row: Record<string, unknown>; source: unknown }>;

function withRows(rows: unknown[]) {
  upserts = [];
  updates = [];
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.in = async () => ({ data: rows, error: null });
  q.upsert = async (row: Record<string, unknown>, opts: Record<string, unknown>) => {
    upserts.push({ row, opts });
    return { error: null };
  };
  q.update = (row: Record<string, unknown>) => ({
    eq: async (_col: string, source: unknown) => {
      updates.push({ row, source });
      return { error: null };
    },
  });
  vi.mocked(getServiceRoleClient).mockReturnValue({ from: () => q } as never);
}

const pages = () => vi.mocked(sendDiscord).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendDiscord).mockResolvedValue(true);
});

describe('checkScoutHeartbeats: reconcile degraded page', () => {
  const others = ['scout-watch', 'scout-cycle', 'auto-exit-cron'].map(fresh);

  it('pages RECONCILE DEGRADED with the skip reason when the route ran degraded for 30+ min', async () => {
    withRows([
      ...others,
      { source: 'reconcile', last_tick_at: iso(2), stale_alerted_at: null, detail: 'reconcile SKIPPED (HL read stale)' },
      { source: 'reconcile-ok', last_tick_at: iso(40), stale_alerted_at: null, detail: 'ok' },
    ]);
    expect((await checkScoutHeartbeats(NOW)).paged).toBe(1);
    expect(pages()).toHaveLength(1);
    expect(pages()[0]).toMatch(/RECONCILE DEGRADED/);
    expect(pages()[0]).toContain('HL read stale');
    // Only the cooldown is stamped: the heal tick is never rewritten.
    expect(updates).toEqual([{ row: { stale_alerted_at: new Date(NOW).toISOString() }, source: 'reconcile-ok' }]);
    expect(upserts).toHaveLength(0);
  });

  it('a failed Discord send does not start the cooldown', async () => {
    vi.mocked(sendDiscord).mockResolvedValue(false);
    withRows([
      ...others,
      { source: 'reconcile', last_tick_at: iso(2), stale_alerted_at: null, detail: 'x' },
      { source: 'reconcile-ok', last_tick_at: iso(40), stale_alerted_at: null, detail: 'ok' },
    ]);
    expect((await checkScoutHeartbeats(NOW)).paged).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('a dead route pages only RECONCILE CRON SILENT', async () => {
    withRows([
      ...others,
      { source: 'reconcile', last_tick_at: iso(120), stale_alerted_at: null, detail: 'x' },
      { source: 'reconcile-ok', last_tick_at: iso(120), stale_alerted_at: null, detail: 'ok' },
    ]);
    await checkScoutHeartbeats(NOW);
    expect(pages()).toHaveLength(1);
    expect(pages()[0]).toMatch(/RECONCILE CRON SILENT/);
  });

  it('seeds an absent reconcile-ok row (without overwriting a real one) and does not page yet', async () => {
    withRows([...others, fresh('reconcile')]);
    await checkScoutHeartbeats(NOW);
    expect(pages()).toHaveLength(0);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].row).toMatchObject({ source: 'reconcile-ok', last_tick_at: new Date(NOW).toISOString() });
    expect(upserts[0].opts).toMatchObject({ ignoreDuplicates: true });
  });
});
