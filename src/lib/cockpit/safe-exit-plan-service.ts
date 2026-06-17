/**
 * Safe-exit-plan service (I/O) — the backstop's persistence.
 *
 * Claude keeps ONE current reduce-only exit plan per session fresh
 * (`upsertSafeExitPlan`); the Safe-Exit panic button reads it
 * (`getSafeExitPlan`) and — per the route — uses it when fresh, else builds a
 * market reduce-only close from the live position. Thin write/read over the
 * service-role client; one plan per session (upsert on session_id).
 */

import { getServiceRoleClient } from './supabase-server';
import type { SafeExitPlan } from '@/types/cockpit';
import type { TradeIntent } from '@/types/fill';
import type { SupabaseClient } from '@supabase/supabase-js';

interface SafeExitPlanRow {
  id: string;
  session_id: string;
  intent: TradeIntent;
  reasoning: string | null;
  is_fallback: boolean;
  updated_at: string;
}

function toSafeExitPlan(row: SafeExitPlanRow): SafeExitPlan {
  return {
    id: row.id,
    sessionId: row.session_id,
    intent: row.intent,
    reasoning: row.reasoning,
    isFallback: row.is_fallback,
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

/**
 * Upsert the current Safe-Exit plan for a session (one row per session). Bumps
 * `updated_at` so the freshness check (isPlanFresh) sees a current plan. Called
 * by Claude's skills as a position evolves to keep the dead-man's switch armed.
 */
export async function upsertSafeExitPlan(
  sessionId: string,
  intent: TradeIntent,
  reasoning: string | null,
  isFallback = false,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<SafeExitPlan> {
  const { data, error } = await client
    .from('safe_exit_plan')
    .upsert(
      {
        session_id: sessionId,
        intent,
        reasoning,
        is_fallback: isFallback,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'session_id' },
    )
    .select()
    .single();
  if (error) throw new Error(`upsertSafeExitPlan failed: ${error.message}`);
  return toSafeExitPlan(data as SafeExitPlanRow);
}

/** Read the current Safe-Exit plan for a session, or null when none exists. */
export async function getSafeExitPlan(
  sessionId: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<SafeExitPlan | null> {
  const { data, error } = await client
    .from('safe_exit_plan')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw new Error(`getSafeExitPlan failed: ${error.message}`);
  if (!data) return null;
  return toSafeExitPlan(data as SafeExitPlanRow);
}
