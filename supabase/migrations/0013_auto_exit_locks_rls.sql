-- SECURITY FIX — enable RLS on auto_exit_locks (Supabase linter: rls_disabled_in_public
-- + sensitive_columns_exposed). This table was created in 0008 WITHOUT row-level
-- security, so the public anon role could read/insert/update/DELETE every row through
-- the PostgREST API (anyone with the project URL + the public anon key). It is a
-- SERVER-INTERNAL table (auto-exit idempotency locks, written/read only via the
-- service-role client, never in the realtime publication, never read by the browser).
--
-- Fix: enable RLS with NO policies. The service-role key BYPASSES RLS, so the
-- auto-exit service keeps working unchanged; the anon role gets ZERO access (no read,
-- no write, no delete) — which is exactly right for a server-only table.
--
-- Idempotent / re-runnable.

alter table public.auto_exit_locks enable row level security;

-- (Intentionally no policies: anon must have no access; service-role bypasses RLS.)
