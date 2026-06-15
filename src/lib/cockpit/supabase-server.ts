/**
 * Server-side Supabase client (SERVICE ROLE). Used by Claude's skills + server
 * routes to WRITE cockpit rows (sessions, fills, positions, pnl, analysis_log,
 * hypotheses, health_snapshots, context_gauge).
 *
 * SECURITY: the service-role key bypasses RLS and MUST NEVER reach the browser.
 * This module is server-only — importing it from a client component is a bug.
 * See ADR-0002 and the RLS in supabase/migrations/0001_init.sql.
 */

import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/** Lazily construct the service-role client from server-only env vars. */
export function getServiceRoleClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase service-role client not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    );
  }

  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
