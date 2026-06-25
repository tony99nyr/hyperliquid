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

/**
 * Resolve the Supabase project URL on the server. The Vercel Supabase
 * Marketplace integration injects the URL with an `HL_` prefix
 * (`HL_SUPABASE_URL` / `NEXT_PUBLIC_HL_SUPABASE_URL`); accept those first, then
 * fall back to the unprefixed names for portability. See env.ts for the full
 * expected-var-name documentation.
 */
function resolveServerUrl(): string | undefined {
  return (
    process.env.HL_TRADERS_SUPABASE_URL ??
    process.env.HL_SUPABASE_URL ??
    process.env.NEXT_PUBLIC_HL_SUPABASE_URL ??
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );
}

/**
 * Resolve the service-role key. The integration injects it as
 * `HL_SUPABASE_SERVICE_ROLE_KEY` (and a `HL_SUPABASE_SECRET_KEY` variant);
 * accept either, then fall back to the unprefixed name.
 */
function resolveServiceRoleKey(): string | undefined {
  return (
    process.env.HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.HL_TRADERS_SUPABASE_SECRET_KEY ??
    process.env.HL_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.HL_SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/** Lazily construct the service-role client from server-only env vars. */
export function getServiceRoleClient(): SupabaseClient {
  if (client) return client;

  const url = resolveServerUrl();
  const serviceRoleKey = resolveServiceRoleKey();
  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase service-role client not configured: set HL_SUPABASE_URL (or SUPABASE_URL) and HL_SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY)',
    );
  }

  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Reset the cached client (test hook only). */
export function _resetServiceRoleClient(): void {
  client = null;
}
