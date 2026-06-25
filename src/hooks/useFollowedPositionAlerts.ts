'use client';

/**
 * useFollowedPositionAlerts — the keep-matched trigger (PR-6). Polls leader_actions
 * (via useLeaderActionsFeed) and, for each PROTECTIVE change (reduce/close/flip) on a
 * position the operator is actively FOLLOWING, POSTs /api/cockpit/follow-match to stage
 * a reduce-only matching suggestion into the approval popup.
 *
 * Conservative + safe: only events DETECTED SINCE this mounted (never replays history),
 * only active follows, each id once. The server gates on FOLLOW_MATCH_ENABLED (no-op
 * when off) and is idempotent (dedupe_key), so a re-POST can never double-stage.
 * NO-AUTO-FIRE: staging only creates a preview the human approves.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';
import { useLeaderActionsFeed } from './useLeaderActionsFeed';

const PROTECTIVE = new Set(['reduce', 'close', 'flip']);
const FOLLOWS_POLL_MS = 30_000;
const EVENT_MAX_AGE_MS = 10 * 60 * 1000;

export interface UseFollowedAlertsState {
  /** How many matches this session has staged into the approval popup. */
  stagedCount: number;
}

export function useFollowedPositionAlerts(): UseFollowedAlertsState {
  const actions = useLeaderActionsFeed({ limit: 100 });
  const followsRef = useRef<Set<string>>(new Set()); // "addr|COIN" active follows
  const seenRef = useRef<Set<string>>(new Set());
  const startedRef = useRef<number>(0);
  const [stagedCount, setStagedCount] = useState(0);

  const loadFollows = useCallback(async () => {
    const { data } = await getBrowserClient().from('followed_positions').select('leader_address, coin').eq('status', 'active');
    followsRef.current = new Set(
      (data ?? []).map((r) => {
        const row = r as { leader_address: string; coin: string };
        return `${row.leader_address.toLowerCase()}|${row.coin.toUpperCase()}`;
      }),
    );
  }, []);

  useEffect(() => {
    startedRef.current = Date.now();
    void loadFollows();
    const id = setInterval(() => void loadFollows(), FOLLOWS_POLL_MS);
    return () => clearInterval(id);
  }, [loadFollows]);

  // Process new qualifying actions in a useCallback so setState stays out of the
  // effect body; the effect just invokes it when the action feed changes.
  const process = useCallback(async () => {
    if (startedRef.current === 0) return;
    const now = Date.now();
    for (const a of actions.rows) {
      if (!PROTECTIVE.has(a.kind)) continue;
      if (a.detectedAt <= startedRef.current) continue; // only events since mount
      if (now - a.detectedAt > EVENT_MAX_AGE_MS) continue;
      const key = `${a.leaderAddress.toLowerCase()}|${a.coin.toUpperCase()}`;
      if (!followsRef.current.has(key)) continue;
      if (seenRef.current.has(a.id)) continue;
      seenRef.current.add(a.id);
      try {
        const res = await fetch('/api/cockpit/follow-match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ leaderActionId: a.id }),
        });
        const j = (await res.json()) as { staged?: boolean };
        if (j?.staged) setStagedCount((c) => c + 1);
      } catch {
        // best-effort; the server gates + is idempotent, so a retry next poll is safe.
      }
    }
  }, [actions.rows]);

  useEffect(() => {
    let active = true;
    const run = () => { if (active) void process(); };
    run();
    return () => { active = false; };
  }, [process]);

  return { stagedCount };
}
