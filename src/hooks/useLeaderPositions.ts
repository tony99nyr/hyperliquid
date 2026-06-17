'use client';

/**
 * useLeaderPositions — keeps the followed leader's live HL positions FRESH for
 * the Leader-vs-You panel (Item 4). The RSC page seeds the initial positions
 * (server-fetched clearinghouseState); this hook short-polls the same admin-authed
 * read-only /api/cockpit/trader-positions proxy so the leader side updates live
 * while the operator watches the trade.
 *
 * READ-ONLY: the proxy fetches the public HL info endpoint; there is no
 * order-placement anywhere. A null address (not following) is inert: no poll,
 * just the (empty) seed. Fail-soft — a failed poll keeps the last good positions.
 */

import { useEffect, useState } from 'react';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

export interface LeaderPositionsState {
  positions: HlPosition[];
  /** True once at least one live poll has resolved (vs the server seed). */
  refreshed: boolean;
  error: string | null;
}

/** Default poll cadence — leader positions move slowly; 15s matches the HL cache. */
const DEFAULT_POLL_MS = 15_000;

export function useLeaderPositions(
  address: string | null,
  seed: HlPosition[] = [],
  pollMs: number = DEFAULT_POLL_MS,
): LeaderPositionsState {
  const [state, setState] = useState<LeaderPositionsState>({ positions: seed, refreshed: false, error: null });

  // Re-seed synchronously when the address changes (store-previous-prop-in-state
  // idiom, as in useTraderDetail) — no ref read during render. A null address is
  // the inert seed state; a real address starts from the seed, then the effect
  // polls. We key the reset on address so a leader switch shows its seed first.
  const [renderedAddress, setRenderedAddress] = useState(address);
  if (renderedAddress !== address) {
    setRenderedAddress(address);
    setState({ positions: seed, refreshed: false, error: null });
  }

  useEffect(() => {
    if (!address) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      try {
        const res = await fetch(
          `/api/cockpit/trader-positions?address=${encodeURIComponent(address as string)}`,
          { headers: { accept: 'application/json' } },
        );
        if (!active) return;
        if (res.ok) {
          const json = (await res.json()) as {
            ok: boolean;
            state?: { positions?: HlPosition[]; error?: string };
          };
          const next = json.state?.positions;
          if (Array.isArray(next)) {
            setState({ positions: next, refreshed: true, error: null });
          }
        }
      } catch {
        // Fail-soft: keep the last good positions; do not clear the panel.
        if (active) setState((s) => ({ ...s, error: 'leader refresh failed' }));
      } finally {
        if (active) timer = setTimeout(() => void poll(), pollMs);
      }
    }

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [address, pollMs]);

  return state;
}
