import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServiceRoleClient = vi.fn();
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: () => getServiceRoleClient() }));

import { releaseOcoClaim } from '@/lib/ladder/ladder-service';

function mockDb(rungs: { id: string; status: string }[], activeFireIds: string[] = []) {
  const deleteEq = vi.fn().mockResolvedValue({ error: null });
  const deleteQuery = { eq: vi.fn().mockReturnValue({ eq: deleteEq }) };
  const rungQuery = { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: rungs, error: null }) }) }) };
  const fireQuery = { select: vi.fn().mockReturnValue({ in: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: activeFireIds.map((id) => ({ id })), error: null }) }) }) }) };
  const from = vi.fn((table: string) => table === 'ladder_rungs' ? rungQuery : table === 'ladder_fires' ? fireQuery : { delete: () => deleteQuery });
  getServiceRoleClient.mockReturnValue({ from });
  return { from, deleteEq };
}

beforeEach(() => vi.clearAllMocks());

describe('releaseOcoClaim', () => {
  it('keeps the claim when another open rung already fired', async () => {
    const db = mockDb([{ id: 'r1', status: 'pending' }, { id: 'r2', status: 'fired' }]);
    await releaseOcoClaim('group', 'ladder');
    expect(db.from).not.toHaveBeenCalledWith('ladder_oco_claims');
  });

  it('keeps the claim when another open rung has a filled fire', async () => {
    const db = mockDb([{ id: 'r1', status: 'pending' }, { id: 'r2', status: 'pending' }], ['f2']);
    await releaseOcoClaim('group', 'ladder');
    expect(db.from).not.toHaveBeenCalledWith('ladder_oco_claims');
  });

  it('releases the claim when no open rung holds a fill', async () => {
    const db = mockDb([{ id: 'r1', status: 'pending' }, { id: 'r2', status: 'failed' }]);
    await releaseOcoClaim('group', 'ladder');
    expect(db.from).toHaveBeenCalledWith('ladder_oco_claims');
    expect(db.deleteEq).toHaveBeenCalledWith('ladder_id', 'ladder');
  });
});
