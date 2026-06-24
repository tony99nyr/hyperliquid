import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useUrlParamState } from '@/hooks/useUrlParamState';

const ALLOWED = ['15m', '1h', '1d'] as const;
type TF = (typeof ALLOWED)[number];

function setUrl(search: string): void {
  window.history.replaceState(null, '', `/cockpit${search}`);
}

describe('useUrlParamState', () => {
  beforeEach(() => setUrl(''));
  afterEach(() => setUrl(''));

  it('starts at the fallback when the param is absent', () => {
    const { result } = renderHook(() => useUrlParamState<TF>('tf', '15m', ALLOWED));
    expect(result.current[0]).toBe('15m');
  });

  it('adopts a valid param from the URL after mount', async () => {
    setUrl('?tf=1h');
    const { result } = renderHook(() => useUrlParamState<TF>('tf', '15m', ALLOWED));
    await waitFor(() => expect(result.current[0]).toBe('1h'));
  });

  it('ignores an invalid param value (keeps the fallback)', async () => {
    setUrl('?tf=bogus');
    const { result } = renderHook(() => useUrlParamState<TF>('tf', '15m', ALLOWED));
    // give the adopt-effect a tick; it must NOT switch to the junk value
    await Promise.resolve();
    expect(result.current[0]).toBe('15m');
  });

  it('writes the param to the URL and updates state on set', () => {
    const { result } = renderHook(() => useUrlParamState<TF>('tf', '15m', ALLOWED));
    act(() => result.current[1]('1d'));
    expect(result.current[0]).toBe('1d');
    expect(new URLSearchParams(window.location.search).get('tf')).toBe('1d');
  });

  it('preserves other query params when writing', () => {
    setUrl('?coin=ETH');
    const { result } = renderHook(() => useUrlParamState<TF>('tf', '15m', ALLOWED));
    act(() => result.current[1]('1h'));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('tf')).toBe('1h');
    expect(params.get('coin')).toBe('ETH');
  });

  it('follows back/forward (popstate) to a new param value', async () => {
    const { result } = renderHook(() => useUrlParamState<TF>('tf', '15m', ALLOWED));
    act(() => {
      setUrl('?tf=1d');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(result.current[0]).toBe('1d'));
  });
});
