import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ladder 82a31710 (BTC FOMC Oct straddle long leg) was archived as a draft, then armed.
// listLadders('armed') hid archived rows, so the watcher never saw the ladder: it stayed
// armed past its Oct 29 expiry. These tests pin both halves of the fix.

type Call = [string, ...unknown[]];
let calls: Call[] = [];
let result: { data: unknown; error: null } = { data: [], error: null };

function query(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'eq', 'is', 'not', 'or', 'in', 'update']) {
    q[m] = (...a: unknown[]) => { calls.push([m, ...a]); return q; };
  }
  q.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return q;
}

vi.mock('@/lib/cockpit/supabase-server', () => ({
  getServiceRoleClient: () => ({ from: (t: string) => { calls.push(['from', t]); return query(); } }),
}));

import { armLadder, disarmLadder, listLadders } from '@/lib/ladder/ladder-service';

const archivedFilters = () => calls.filter((c) => ['is', 'not', 'or'].includes(c[0]) && String(c[1]).startsWith('archived_at'));

beforeEach(() => { calls = []; result = { data: [], error: null }; });

describe('listLadders and archived rows', () => {
  it('never hides an armed row, archived or not (the watcher must expire it)', async () => {
    await listLadders('armed');
    expect(calls).toContainEqual(['eq', 'status', 'armed']);
    expect(archivedFilters()).toEqual([['or', 'archived_at.is.null,status.eq.armed']]);
  });

  it('still lists only archived ladders for the archived audit view', async () => {
    await listLadders(undefined, { archived: true });
    expect(archivedFilters()).toEqual([['not', 'archived_at', 'is', null]]);
  });

  it('lists the given ids whether they are archived or not', async () => {
    await listLadders('expired', { ids: ['L1'] });
    expect(calls).toContainEqual(['in', 'id', ['L1']]);
    expect(archivedFilters()).toEqual([]);
  });
});

describe('armLadder and archived drafts', () => {
  it('refuses to arm an archived draft', async () => {
    await armLadder('L1', { preconditionHash: 'h', expiresAtMs: 0, cloidByRungId: {}, expectedUpdatedAt: 'u' });
    expect(calls).toContainEqual(['eq', 'status', 'draft']);
    expect(calls).toContainEqual(['is', 'archived_at', null]);
  });
});

describe('disarmLadder', () => {
  it('never overwrites a done or expired status, and says whether it disarmed', async () => {
    expect(await disarmLadder('L1', 'archived')).toBe(false);
    expect(calls).toContainEqual(['eq', 'id', 'L1']);
    expect(calls).toContainEqual(['in', 'status', ['armed', 'draft']]);
    result = { data: [{ id: 'L1' }], error: null };
    expect(await disarmLadder('L1', 'archived')).toBe(true);
  });
});
