import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: () => ({ rpc }) }));

import { releaseOcoClaim } from '@/lib/ladder/ladder-service';

beforeEach(() => vi.clearAllMocks());

describe('releaseOcoClaim', () => {
  it('uses one atomic database operation scoped to the failed rung', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await releaseOcoClaim('group', 'ladder', 'failed-rung');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('release_oco_ladder_claim', {
      p_group_id: 'group', p_ladder_id: 'ladder', p_rung_id: 'failed-rung',
    });
  });

  it('keeps a sibling claim when SQL reports another claimed or filled open', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await releaseOcoClaim('group', 'ladder', 'failed-rung');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('throws if the migration is missing so the caller can page the operator', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    await expect(releaseOcoClaim('group', 'ladder', 'failed-rung')).rejects.toThrow('function does not exist');
  });
});
