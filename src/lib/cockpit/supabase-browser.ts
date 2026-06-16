/**
 * Browser Supabase client (ANON key). Used by the cockpit UI to READ cockpit
 * rows and subscribe to Postgres realtime per session. The anon key + RLS
 * (select-only for anon) make this safe to ship to the phone — it can read live
 * trade state but cannot write. All writes go through the server service-role
 * client. See ADR-0002.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/**
 * Lazily construct the anon (read + realtime) client from public env vars.
 *
 * The Vercel Supabase Marketplace integration injects the public vars with an
 * `HL_` prefix (`NEXT_PUBLIC_HL_SUPABASE_URL` / `NEXT_PUBLIC_HL_SUPABASE_ANON_KEY`,
 * plus a `NEXT_PUBLIC_HL_SUPABASE_PUBLISHABLE_KEY` variant). Accept those first,
 * then fall back to the unprefixed names for portability. Only `NEXT_PUBLIC_*`
 * vars are inlined into the browser bundle, so the server-only `HL_SUPABASE_URL`
 * fallback is a dev-only convenience and resolves to undefined client-side.
 */
export function getBrowserClient(): SupabaseClient {
  if (client) return client;

  const url =
    process.env.NEXT_PUBLIC_HL_SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.HL_SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_HL_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_HL_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Supabase browser client not configured: set NEXT_PUBLIC_HL_SUPABASE_URL and NEXT_PUBLIC_HL_SUPABASE_ANON_KEY (or the unprefixed names)',
    );
  }

  client = createClient(url, anonKey, {
    auth: { persistSession: false },
  });
  return client;
}
