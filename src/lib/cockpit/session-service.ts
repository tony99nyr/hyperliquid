/**
 * Session service (I/O). Opens + closes a trading session row. A session groups
 * all cockpit state (fills, positions, analysis, hypotheses, health, gauge) for
 * one human+Claude sitting. Writes go through the service-role client; the
 * row-shape construction is the PURE `buildSessionRow` (cockpit-rows-*).
 */

import { getServiceRoleClient } from './supabase-server';
import { buildSessionRow } from './cockpit-rows-business-logic';
import type { Session } from '@/types/cockpit';
import type { TradingMode } from '@/types/fill';
import type { SupabaseClient } from '@supabase/supabase-js';

interface SessionRow {
  id: string;
  created_at: string;
  status: Session['status'];
  mode: TradingMode;
  title: string | null;
  leader_address: string | null;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    createdAt: new Date(row.created_at).getTime(),
    status: row.status,
    mode: row.mode,
    title: row.title,
    leaderAddress: row.leader_address,
  };
}

/** Open a new trading session and return the created row. */
export async function openSession(
  input: { mode: TradingMode; title?: string | null; leaderAddress?: string | null },
  client: SupabaseClient = getServiceRoleClient(),
): Promise<Session> {
  const row = buildSessionRow({ ...input, status: 'active' });
  const { data, error } = await client.from('sessions').insert(row).select().single();
  if (error) throw new Error(`openSession failed: ${error.message}`);
  return toSession(data as SessionRow);
}

/**
 * Read the most-recent active session (the one the cockpit live-tracks). Returns
 * null when none exists OR when Supabase is not yet configured — the cockpit page
 * renders in a "no session" state rather than erroring, so it is viewable before
 * the DB is provisioned.
 */
export async function getActiveSession(
  clientFactory: () => SupabaseClient = getServiceRoleClient,
): Promise<Session | null> {
  let client: SupabaseClient;
  try {
    client = clientFactory();
  } catch {
    return null; // Supabase not configured yet — fail soft.
  }
  const { data, error } = await client
    .from('sessions')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return toSession(data as SessionRow);
}

/**
 * List ALL active sessions (most-recent first). Used by the non-agent watch
 * daemon, which monitors every active sitting (not just the single newest one
 * the cockpit live-tracks). Fail-soft: returns [] when Supabase is unconfigured
 * so the daemon can start before the DB is provisioned and simply find nothing.
 */
export async function listActiveSessions(
  clientFactory: () => SupabaseClient = getServiceRoleClient,
): Promise<Session[]> {
  let client: SupabaseClient;
  try {
    client = clientFactory();
  } catch {
    return []; // Supabase not configured yet — fail soft.
  }
  const { data, error } = await client
    .from('sessions')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return (data as SessionRow[]).map(toSession);
}

/** Close a session (status → 'closed'). */
export async function closeSession(
  sessionId: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<void> {
  const { error } = await client
    .from('sessions')
    .update({ status: 'closed' })
    .eq('id', sessionId);
  if (error) throw new Error(`closeSession failed: ${error.message}`);
}
