-- HL Cockpit — Phase 1: approval gate + Safe-Exit backstop.
--
-- Two new durable tables that drive the SAFETY-CRITICAL trade-execution path:
--
--   * pending_actions — the NO-AUTO-FIRE approval queue. A skill writes a
--     'pending' row describing a proposed trade; nothing executes until the
--     human flips it to 'approved' from the web popup. timeout/reject/error all
--     resolve to 'expired'/'rejected' ⇒ NO execution. Default is always NO.
--
--   * safe_exit_plan — the dead-man's-switch backstop. Claude keeps ONE current
--     reduce-only exit plan per session fresh; the Safe-Exit panic button uses
--     it when fresh, else builds a market reduce-only close from the live
--     position. Executes with ZERO dependency on a live Claude session.
--
-- Security model (ADR-0002, identical to 0001): anon → SELECT only; all writes
-- are service-role (server routes / skills). REPLICA IDENTITY FULL + the
-- supabase_realtime publication push per-row updates to the browser so the
-- popup + Safe-Exit freshness render live.
--
-- Idempotent / re-runnable: IF NOT EXISTS on tables/indexes, drop-policy-if-
-- exists before create, publication membership guarded.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.pending_actions (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions(id) on delete cascade,
  kind        text not null check (kind in ('entry','exit','generic')),
  mode        text not null check (mode in ('paper','live')),
  -- The proposed TradeIntent + display fields (coin/side/sz/px/stop/rationale).
  proposal    jsonb not null,
  status      text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);

create table if not exists public.safe_exit_plan (
  id           uuid primary key default gen_random_uuid(),
  -- One CURRENT plan per session — upsert on session_id.
  session_id   uuid not null unique references public.sessions(id) on delete cascade,
  -- The reduce-only exit TradeIntent (opposite side, full size, market).
  intent       jsonb not null,
  reasoning    text,
  -- True when the plan is the mechanical market-close fallback rather than a
  -- Claude-authored exit (audit cue; the route also recomputes freshness).
  is_fallback  boolean not null default false,
  updated_at   timestamptz not null default now()
);

-- Per-session ordering index for the realtime popup stream.
create index if not exists idx_pending_actions_session on public.pending_actions (session_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Realtime: REPLICA IDENTITY FULL + add to the supabase_realtime publication
-- (matches 0001_init.sql; guarded so re-running does not error).
-- ---------------------------------------------------------------------------

alter table public.pending_actions replica identity full;
alter table public.safe_exit_plan  replica identity full;

do $$
declare
  t text;
  tables text[] := array['pending_actions','safe_exit_plan'];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array tables loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: anon may SELECT only; all writes require service-role
-- (which bypasses RLS). No INSERT/UPDATE/DELETE policies granted to anon.
-- ---------------------------------------------------------------------------

alter table public.pending_actions enable row level security;
alter table public.safe_exit_plan  enable row level security;

drop policy if exists "anon read pending_actions" on public.pending_actions;
drop policy if exists "anon read safe_exit_plan"  on public.safe_exit_plan;

create policy "anon read pending_actions" on public.pending_actions for select using (true);
create policy "anon read safe_exit_plan"  on public.safe_exit_plan  for select using (true);
