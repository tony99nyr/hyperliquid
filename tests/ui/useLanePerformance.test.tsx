import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLanePerformance } from '@/hooks/useLanePerformance';
import type { LanePerformanceReport } from '@/lib/performance/lane-performance-business-logic';

afterEach(() => vi.unstubAllGlobals());

it('keeps the last good report after GET 500 and exposes the server message for Retry', async () => {
  const good = { schemaVersion: 1, generatedAt: '2026-10-24T12:00:00Z' } as LanePerformanceReport;
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => good })
    .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ ok: false, error: 'Ledger unavailable' }) });
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useLanePerformance(60_000));
  await waitFor(() => expect(result.current.data).toBe(good));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.status).toBe(500));
  expect(result.current.lastGood).toBe(good);
  expect(result.current.isStale).toBe(true);
  expect(result.current.error).toContain('Ledger unavailable');
});

it('treats 404 as skew, but checks schemaVersion only on a successful GET', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ ok: false, error: 'Missing endpoint' }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ schemaVersion: 2 }) });
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useLanePerformance(60_000));
  await waitFor(() => expect(result.current.status).toBe(404));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.status).toBe(422));
});

it('treats a non-JSON success as an error, not schema skew', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }));
  const { result } = renderHook(() => useLanePerformance(60_000));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.status).toBe(0);
  expect(result.current.data).toBeNull();
});

it('keeps a confirmed marker optimistic until a poll includes it', async () => {
  const marker = { id: 'm1', confirmed_at: null };
  const good = { schemaVersion: 1, markers: [marker] } as LanePerformanceReport;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => good }));
  const { result } = renderHook(() => useLanePerformance(60_000));
  await waitFor(() => expect(result.current.data).toBeTruthy());
  act(() => result.current.confirmMarker('m1'));
  expect(result.current.data!.markers[0]!.confirmed_at).toBeTruthy();
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.data!.markers[0]!.confirmed_at).toBeTruthy());
});
