'use client';

/**
 * useTraderEvaluation — reads the latest persisted copyability fingerprint for a
 * trader (trader_evaluations, anon select) and can trigger an on-demand re-vet
 * (POST /api/cockpit/research-trader → the NAS worker fills it; we poll for the
 * fresh row). One-evaluation-two-consumers: this is the same row the review-trader
 * skill reads.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';

export interface TraderEvaluation {
  verdict: 'follow' | 'caution' | 'avoid';
  persistenceConfidence: 'multi-window' | 'single-window' | 'insufficient';
  metrics: Record<string, number | string | null>;
  windowLabel: string;
  fillsSeen: number;
  generatedAt: string;
}

export interface UseTraderEvaluationState {
  evaluation: TraderEvaluation | null;
  loading: boolean;
  vetting: boolean;
  error: string | null;
  /** Enqueue an on-demand vet, then poll until a newer evaluation lands (or times out). */
  vet: () => Promise<void>;
}

const POLL_MS = 4000;
const POLL_TIMEOUT_MS = 45_000;

function mapRow(r: Record<string, unknown> | null): TraderEvaluation | null {
  if (!r) return null;
  return {
    verdict: r.verdict as TraderEvaluation['verdict'],
    persistenceConfidence: r.persistence_confidence as TraderEvaluation['persistenceConfidence'],
    metrics: (r.metrics as TraderEvaluation['metrics']) ?? {},
    windowLabel: (r.window_label as string) ?? '',
    fillsSeen: (r.fills_seen as number) ?? 0,
    generatedAt: (r.generated_at as string) ?? '',
  };
}

export function useTraderEvaluation(address: string | null): UseTraderEvaluationState {
  const [evaluation, setEvaluation] = useState<TraderEvaluation | null>(null);
  const [loading, setLoading] = useState(true);
  const [vetting, setVetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addr = address ? address.toLowerCase() : null;

  const fetchLatest = useCallback(async (): Promise<TraderEvaluation | null> => {
    if (!addr) return null;
    const { data } = await getBrowserClient()
      .from('trader_evaluations')
      .select('*')
      .eq('leader_address', addr)
      .order('generated_at', { ascending: false })
      .limit(1);
    return mapRow((data?.[0] as Record<string, unknown> | undefined) ?? null);
  }, [addr]);

  // setState lives in a useCallback (refetch); the effect only CALLS it — keeps
  // setState out of the effect body (react-hooks/set-state-in-effect), mirroring
  // useFavorites. loading initializes true and refetch clears it.
  const refetch = useCallback(async () => {
    const e = await fetchLatest();
    setEvaluation(e);
    setLoading(false);
    // A fresh load (incl. on address change) means no vet is in progress for THIS read.
    setVetting(false);
    setError(null);
  }, [fetchLatest]);

  useEffect(() => {
    let active = true;
    const run = () => { if (active) void refetch(); };
    run();
    return () => { active = false; };
  }, [refetch]);

  const vetTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Clear a running vet poll on unmount OR address change (no stale cross-trader write).
  useEffect(() => () => { if (vetTimer.current) { clearInterval(vetTimer.current); vetTimer.current = null; } }, [addr]);

  const vet = useCallback(async () => {
    if (!addr || vetting) return;
    setVetting(true);
    setError(null);
    const baseline = evaluation?.generatedAt ?? '';
    try {
      const res = await fetch('/api/cockpit/research-trader', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ address: addr }),
      });
      if (!res.ok) throw new Error(`vet request ${res.status}`);
    } catch (e) {
      setVetting(false);
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    // Poll for a NEWER evaluation than the baseline.
    const started = Date.now();
    if (vetTimer.current) clearInterval(vetTimer.current);
    vetTimer.current = setInterval(() => {
      void fetchLatest().then((e) => {
        if (e && e.generatedAt !== baseline) {
          setEvaluation(e);
          setVetting(false);
          if (vetTimer.current) clearInterval(vetTimer.current);
        } else if (Date.now() - started > POLL_TIMEOUT_MS) {
          setVetting(false);
          setError('vetting timed out — the worker may be offline');
          if (vetTimer.current) clearInterval(vetTimer.current);
        }
      });
    }, POLL_MS);
  }, [addr, vetting, evaluation, fetchLatest]);

  return { evaluation, loading, vetting, error, vet };
}
