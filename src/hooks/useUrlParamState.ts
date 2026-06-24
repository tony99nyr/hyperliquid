'use client';

/**
 * useUrlParamState — a piece of UI state mirrored to a URL search param, so a
 * REFRESH or browser BACK/FORWARD retains the selection (e.g. the chart
 * timeframe `?tf=15m`). Generic over a string-literal union; an optional
 * `allowed` list rejects junk param values (falling back to the default).
 *
 * SSR-safe: the initial render is ALWAYS `fallback` (matching the server), then
 * a post-hydration effect adopts a valid value from the URL — so there's no
 * hydration mismatch on the param-driven markup. Updates use `replaceState`
 * (the selection is a view preference, not a navigation step — it shouldn't trap
 * the back button), and a `popstate` listener keeps the value in lock-step when
 * the user navigates back/forward to a URL carrying a different value.
 */

import { useCallback, useEffect, useState } from 'react';

export function useUrlParamState<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): [T, (next: T) => void] {
  const isValid = useCallback(
    (v: string | null): v is T => v != null && (!allowed || (allowed as readonly string[]).includes(v)),
    [allowed],
  );

  const [value, setValue] = useState<T>(fallback);

  // Adopt the URL param on mount + whenever back/forward changes it (popstate).
  useEffect(() => {
    const sync = (): void => {
      const fromUrl = new URLSearchParams(window.location.search).get(key);
      if (isValid(fromUrl)) setValue((cur) => (fromUrl !== cur ? fromUrl : cur));
    };
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [key, isValid]);

  const set = useCallback(
    (next: T): void => {
      setValue(next);
      const params = new URLSearchParams(window.location.search);
      params.set(key, next);
      // Preserve the framework's history.state; only rewrite the query string.
      window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);
    },
    [key],
  );

  return [value, set];
}
