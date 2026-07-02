'use client';

/**
 * useNow — a render-safe "current time" (epoch ms) that ticks on an interval. Reading
 * Date.now() during render is impure (react-hooks/purity — a re-render would see a
 * different value); this holds it in state and refreshes every `intervalMs`, so
 * countdown-style UI (ladder expiry chips) both lints clean AND stays current while
 * the surface sits open.
 */

import { useEffect, useState } from 'react';

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
