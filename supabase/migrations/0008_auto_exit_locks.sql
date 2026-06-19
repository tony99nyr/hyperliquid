-- HL Cockpit — auto-exit locks (Layer-1 idempotency / anti-double-close).
--
-- Two detectors can fire for the same position near-simultaneously (the NAS
-- detector + the Vercel cron backup). A per-(session, coin) lock makes the
-- reduce-only close fire AT MOST ONCE per cooldown window: the partial unique
-- index guarantees exactly one ACTIVE lock per key (a concurrent acquire hits a
-- unique violation and backs off), and leaving a lock active until expires_at
-- doubles as the cooldown (a successful close keeps the lock until expiry; a
-- failed close releases immediately so the next cycle can retry).
--
-- Idempotent / re-runnable. Not in the realtime publication (server-internal).

create table if not exists public.auto_exit_locks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  coin text not null,
  reason text,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released boolean not null default false,
  released_at timestamptz,
  outcome text
);

-- Exactly one ACTIVE (un-released) lock per (session, coin). The concurrent
-- second INSERT violates this and is caught as "already held / cooling down".
create unique index if not exists auto_exit_locks_active_uq
  on public.auto_exit_locks (session_id, coin) where released = false;

-- Reap query support: released = false AND expires_at < now().
create index if not exists idx_auto_exit_locks_expiry
  on public.auto_exit_locks (released, expires_at);
