'use client';

/**
 * Auto-bind the LATEST active session. Seeds from the server-rendered session
 * (RSC page) for an instant first paint, then polls /api/cockpit/active-session
 * so a session opened MID-FLOW (operator runs open-session while the cockpit is
 * already on screen) surfaces its approval popup + Safe-Exit button WITHOUT a
 * manual page refresh.
 *
 * Polling (not realtime) because there is no session before one exists to
 * subscribe to, and the cadence here is cheap + low-frequency. Once a session is
 * bound, its per-table state arrives via the realtime hooks.
 */

import { useEffect, useState } from 'react';
import type { Session } from '@/types/cockpit';

// 15s (was 5s): a mid-flow session open surfacing ~15s later is fine, and this is a
// continuous background poll — 3x fewer function invocations (Vercel CPU + egress).
const POLL_MS = 15_000;

export function useActiveSession(initial: Session | null): Session | null {
  const [session, setSession] = useState<Session | null>(initial);

  useEffect(() => {
    let active = true;
    async function poll(): Promise<void> {
      // Pause while the tab is hidden — a backgrounded/left-open cockpit should not
      // keep billing function invocations. Resumes immediately on visibilitychange.
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await fetch('/api/cockpit/active-session', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { session?: Session | null };
        if (!active) return;
        const next = json.session ?? null;
        // Only update when the bound session id actually changes, to avoid
        // churning child subscriptions on every poll.
        setSession((prev) => (prev?.id === next?.id ? prev : next));
      } catch {
        // Network blip — keep the last known session.
      }
    }
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    const onVis = () => { if (!document.hidden) void poll(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      active = false;
      clearInterval(t);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return session;
}
