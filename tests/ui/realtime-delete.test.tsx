/**
 * DELETE path of the realtime hooks.
 *
 * With RLS on, a Supabase DELETE payload carries `eventType: 'DELETE'`, `new: {}`
 * and only the primary key in `old`. The hooks must remove the row at once. The
 * old code mapped `payload.new ?? payload.old`, so a DELETE added a blank row
 * (from `new: {}`) and kept the deleted row until the next snapshot refresh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { createRealtimeBrowserMock } from '../mocks/supabase-realtime.mock';

const realtime = createRealtimeBrowserMock({
  data: [
    { id: 'a', source: 'scout-watch', created_at: 2, last_tick_at: 2 },
    { id: 'b', source: 'reconcile-ok', created_at: 1, last_tick_at: 1 },
  ],
  error: null,
});
vi.mock('@/lib/cockpit/supabase-browser', () => ({
  getBrowserClient: () => realtime.client,
}));

import { useRealtimeChannel } from '@/hooks/useRealtimeChannel';
import { useScoutHeartbeat } from '@/hooks/useScoutHeartbeat';

type Row = { id: string; createdAt: number };

function ChannelHarness() {
  const { rows } = useRealtimeChannel<Row>({
    table: 'positions',
    sessionId: 'sess-1',
    map: (r) => ({ id: String(r.id), createdAt: Number(r.created_at ?? 0) }),
    compare: (a, b) => b.createdAt - a.createdAt,
  });
  return <div data-testid="ids">{rows.map((r) => r.id).join(',')}</div>;
}

function HeartbeatHarness() {
  const { rows } = useScoutHeartbeat();
  return <div data-testid="ids">{rows.map((r) => r.id).join(',')}</div>;
}

beforeEach(() => {
  realtime.reset();
});

describe('realtime hooks remove a row on DELETE', () => {
  it('useRealtimeChannel drops the row named by the key-only old', async () => {
    await act(async () => {
      render(<ChannelHarness />);
    });
    expect(screen.getByTestId('ids').textContent).toBe('a,b');

    await act(async () => {
      realtime.emit('rt:positions:', { eventType: 'DELETE', new: {}, old: { id: 'a' } });
    });
    expect(screen.getByTestId('ids').textContent).toBe('b');
  });

  // scout_heartbeat left the realtime publication in 0024, so production sends no
  // event here. The test covers the generic useRealtimeTable path and a mapper
  // whose id is a non-`id` primary key.
  it('useRealtimeTable (scout_heartbeat) drops the row keyed by source', async () => {
    await act(async () => {
      render(<HeartbeatHarness />);
    });
    expect(screen.getByTestId('ids').textContent).toBe('scout-watch,reconcile-ok');

    await act(async () => {
      realtime.emit('rt-table:scout_heartbeat:', { eventType: 'DELETE', new: {}, old: { source: 'scout-watch' } });
    });
    expect(screen.getByTestId('ids').textContent).toBe('reconcile-ok');
  });
});
