import { describe, expect, it, vi } from 'vitest';

const update = vi.fn();
const eq = vi.fn();
const from = vi.fn();
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: () => ({ from }) }));

import { markLadderExpired } from '@/lib/ladder/ladder-service';

describe('markLadderExpired', () => {
  it('changes only the ladder row, leaving a moved exchange stop at its price', async () => {
    const stop = { coin: 'BTC', oid: 77, triggerPx: 104 };
    const exchangeOrders = [stop];
    const query = { update, eq };
    from.mockReturnValue(query);
    update.mockReturnValue(query);
    eq.mockImplementation((field: string) => field === 'status'
      ? Promise.resolve({ error: null }) : query);

    await markLadderExpired('ladder-1');

    expect(from).toHaveBeenCalledWith('ladders');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'expired', disarm_reason: 'expired',
    }));
    expect(Object.keys(update.mock.calls[0][0]).sort()).toEqual([
      'disarm_reason', 'disarmed_at', 'status', 'updated_at',
    ]);
    expect(exchangeOrders).toEqual([{ coin: 'BTC', oid: 77, triggerPx: 104 }]);
  });
});
