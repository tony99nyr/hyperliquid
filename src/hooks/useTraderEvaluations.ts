'use client';

/**
 * useTraderEvaluations — loads the WHOLE persisted copyability evaluation set
 * (trader_evaluations, anon select) into a by-address map for the traders table:
 * the Copyability column + the "Followable / Hide avoid / Hide no-evidence" filters
 * read from it. The table is off realtime, so we POLL (60s) like useFavorites.
 * One-evaluation-two-consumers: same rows the drawer + review-trader skill read.
 */

import { useCallback, useEffect, useState } from 'react';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';
import type { TraderEvalLite, Verdict } from '@/lib/cockpit/traders-table-business-logic';

const REFRESH_MS = 60_000;

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface UseTraderEvaluationsState {
  /** address (lowercased) → the slim evaluation the table needs. */
  evals: Map<string, TraderEvalLite>;
  loading: boolean;
  /** Stable accessor for sort/filter injection. */
  getEval: (address: string) => TraderEvalLite | null;
}

export function useTraderEvaluations(): UseTraderEvaluationsState {
  const [evals, setEvals] = useState<Map<string, TraderEvalLite>>(new Map());
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      // The copyability column is enrichment — a missing/misconfigured client must
      // never crash the table; it just renders without verdicts.
      const { data, error } = await getBrowserClient()
        .from('trader_evaluations')
        .select('leader_address, verdict, metrics, generated_at')
        .order('generated_at', { ascending: false }); // newest first → first seen per address wins
      if (!error && data) {
        const map = new Map<string, TraderEvalLite>();
        for (const r of data as Array<{ leader_address: string; verdict: string; metrics: Record<string, unknown> | null }>) {
          const addr = String(r.leader_address).toLowerCase();
          if (map.has(addr)) continue; // already have the latest (ordered desc)
          const m = r.metrics ?? {};
          map.set(addr, {
            verdict: r.verdict as Verdict,
            addsPerTrip: n(m.addsPerTrip),
            roundTrips: n(m.roundTrips),
          });
        }
        setEvals(map);
      }
    } catch {
      // leave evals empty — the table degrades to "no verdicts" gracefully
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    const run = () => { if (active) void refetch(); };
    run();
    const id = setInterval(run, REFRESH_MS);
    return () => { active = false; clearInterval(id); };
  }, [refetch]);

  const getEval = useCallback((address: string) => evals.get(address.toLowerCase()) ?? null, [evals]);

  return { evals, loading, getEval };
}
