'use client';

/**
 * useTraderDetail — fetches a rated trader's LIVE open positions on demand (when
 * the trader-detail drawer opens). Calls the admin-authed read-only
 * /api/cockpit/trader-positions proxy (HL clearinghouseState). Returns loading +
 * error states so the drawer can render a spinner / error message.
 *
 * Passing a null address (drawer closed) is inert: no fetch, empty state. The
 * fetch re-runs whenever the address changes (the operator clicks a new trader).
 */

import { useEffect, useState } from 'react';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

export interface TraderDetailState {
  positions: HlPosition[];
  accountValueUsd: number | null;
  loading: boolean;
  error: string | null;
  /** True when the data came from a stale cache after a live fetch failure. */
  stale: boolean;
}

const EMPTY: TraderDetailState = {
  positions: [],
  accountValueUsd: null,
  loading: false,
  error: null,
  stale: false,
};

export function useTraderDetail(address: string | null): TraderDetailState {
  // Initial state: a real address is already "loading" (the effect will fetch);
  // a null address is the inert EMPTY state.
  const [state, setState] = useState<TraderDetailState>(address ? { ...EMPTY, loading: true } : EMPTY);

  // Reset synchronously on address change (store-previous-prop-in-state idiom, as
  // in useRegimeStrip) so we never setState inside the effect body for the reset.
  // A real address starts loading; a null address is the inert EMPTY state.
  const [renderedAddress, setRenderedAddress] = useState(address);
  if (renderedAddress !== address) {
    setRenderedAddress(address);
    setState(address ? { ...EMPTY, loading: true } : EMPTY);
  }

  useEffect(() => {
    if (!address) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/cockpit/trader-positions?address=${encodeURIComponent(address)}`,
          { headers: { accept: 'application/json' } },
        );
        if (!active) return;
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          setState({ ...EMPTY, error: json.error ?? `Request failed (${res.status})` });
          return;
        }
        const json = (await res.json()) as {
          ok: boolean;
          state?: {
            positions: HlPosition[];
            accountValueUsd: number;
            stale: boolean;
            error?: string;
          };
        };
        if (!active) return;
        const s = json.state;
        if (!s) {
          setState({ ...EMPTY, error: 'No data returned.' });
          return;
        }
        setState({
          positions: s.positions ?? [],
          accountValueUsd: Number.isFinite(s.accountValueUsd) ? s.accountValueUsd : null,
          loading: false,
          // A stale-cache fetch that still carried an error is surfaced as a soft note.
          error: s.error && (!s.positions || s.positions.length === 0) ? s.error : null,
          stale: s.stale === true,
        });
      } catch {
        if (active) setState({ ...EMPTY, error: 'Network error — try again.' });
      }
    })();
    return () => {
      active = false;
    };
  }, [address]);

  return state;
}
