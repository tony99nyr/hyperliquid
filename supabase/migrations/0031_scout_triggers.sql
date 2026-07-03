-- 0031_scout_triggers — the Trigger sink becomes a Supabase table (C1 of the scout
-- architecture review, 2026-07-03).
--
-- The old sink was a MACHINE-LOCAL JSONL (~/.hl-cockpit-scout-trigger.jsonl): a NAS
-- daemon's triggers were invisible to a desktop Scout session (the split-brain that let
-- the consumer die unnoticed for 8 days), the consumer tail-read with no seen-cursor
-- (churn re-surfaced every wake), and the file was the subsystem's only untested I/O.
-- This table is the primary sink; the JSONL remains a dev/offline fallback adapter.
-- consumed_at is the consumer's cursor: null = not yet seen by a scout cycle.
--
-- Idempotent / re-runnable.

create table if not exists public.scout_triggers (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  coin         text not null,
  side         text check (side in ('long','short')),
  urgency      text not null default 'info' check (urgency in ('info','act')),
  detail       text not null,
  at           timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists scout_triggers_unconsumed_idx on public.scout_triggers (consumed_at, at desc);
create index if not exists scout_triggers_at_idx on public.scout_triggers (at desc);

alter table public.scout_triggers enable row level security;
drop policy if exists "anon read scout_triggers" on public.scout_triggers;
create policy "anon read scout_triggers" on public.scout_triggers for select using (true);
-- Writes are service-role only (no INSERT/UPDATE/DELETE policies — the 0013 lesson).
-- NOT in the realtime publication (the scout polls; migration 0024 discipline).
