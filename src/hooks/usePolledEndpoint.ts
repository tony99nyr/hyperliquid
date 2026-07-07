'use client';

/**
 * Generic same-origin JSON poller for the cockpit's read-only HL-backed endpoints
 * (stops, account-risk, …). Pauses while the tab is hidden, keeps the last-good data
 * through a transient failure (only sets `data` on success), and stops when disabled.
 * `pick` extracts the payload from the `{ ok, ... }` envelope. One place for the poll
 * mechanics so each endpoint hook is a 3-line wrapper.
 */

import { useEffect, useState } from 'react';
import { isPageActive, onActivityResume } from './page-activity';

export interface PolledState<T> {
  data: T | null;
  /** True once the first fetch resolves — until then callers show "checking…". */
  loaded: boolean;
  error: string | null;
}

export function usePolledEndpoint<T>(
  url: string,
  enabled: boolean,
  pick: (json: { ok?: boolean } & Record<string, unknown>) => T | undefined,
  pollMs: number,
): PolledState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = async () => {
      // Hidden OR idle (no user input for the activity window) ⇒ skip the fetch — an
      // unattended tab must not bill Vercel all night. Input resumes instantly below.
      if (!isPageActive()) return;
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Record<string, unknown>;
        if (!active) return;
        const picked = json.ok ? pick(json) : undefined;
        if (picked !== undefined) { setData(picked); setError(null); }
        else setError(json.error ?? `failed (${res.status})`);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoaded(true);
      }
    };
    void load();
    const timer = setInterval(load, pollMs);
    const onVis = () => { if (!document.hidden) void load(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    const offResume = onActivityResume(() => void load()); // instant refresh on return-from-idle
    return () => {
      active = false;
      clearInterval(timer);
      offResume();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, [url, enabled, pick, pollMs]);

  return { data, loaded, error };
}
