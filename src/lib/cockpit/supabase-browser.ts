/**
 * Browser Supabase client (ANON key). Used by the cockpit UI to READ cockpit
 * rows and subscribe to Postgres realtime per session. The anon key + RLS
 * (select-only for anon) make this safe to ship to the phone — it can read live
 * trade state but cannot write. All writes go through the server service-role
 * client. See ADR-0002.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/** Lazily construct the anon (read + realtime) client from public env vars. */
export function getBrowserClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Supabase browser client not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY',
    );
  }

  client = createClient(url, anonKey, {
    auth: { persistSession: false },
  });
  return client;
}
