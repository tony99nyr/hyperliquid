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
