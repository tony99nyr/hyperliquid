-- HL Cockpit — Trade-Watch Service, Phase A: leader watcher tables.
--
-- The trade-watch service is an always-on, NON-AGENT poller that runs on the NAS
-- (alongside the relayer), reads the public Hyperliquid `/info` API for the top
-- rated "leader" wallets, and keeps Supabase fresh so the cockpit + skills READ
-- Supabase instead of hammering HL. It NEVER trades — it observes and reports.
--
-- This migration adds the two LEADER tables it writes:
--
--   * leader_positions — the CURRENT open positions of each watched leader, one
--     row per (leader_address, coin). The service deletes coins a leader has
--     closed and upserts the rest, so the table is always exactly the live book.
--     Drives the cockpit Top-Traders rail / trader-detail drawer / Leader-vs-You.
--
--   * leader_actions — an append-only event log of observed TRANSITIONS
--     (open/add/reduce/close/flip), diffed cycle-over-cycle from the position
--     snapshots. Powers the live action feed and (Phase D) trail-the-leader exit
--     cues. Append-only: a row is a fact that happened at `detected_at`.
--
-- (rated_wallets — job (a), the daily deep re-rank — lands in Phase B's migration.)
--
-- Security model (ADR-0002, identical to 0001/0002): anon → SELECT only; all
-- writes are service-role (the NAS service). REPLICA IDENTITY FULL + the
-- supabase_realtime publication push per-row changes to the browser so the rail
-- + action feed render live.
--
-- Idempotent / re-runnable: IF NOT EXISTS on tables/indexes, drop-policy-if-
-- exists before create, publication membership guarded.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.leader_positions (
  id                uuid primary key default gen_random_uuid(),
  leader_address    text not null,
  coin              text not null,
  side              text not null check (side in ('long','short')),
  -- Signed size in coin units (negative = short); `size` is the absolute value.
  szi               double precision not null,
  size              double precision not null,
  entry_px          double precision,
  position_value    double precision not null default 0,
  unrealized_pnl    double precision not null default 0,
  return_on_equity  double precision,
  leverage          double precision,
  leverage_type     text,
  liquidation_px    double precision,
  -- Leader-account-level field, denormalized onto each position row for a cheap
  -- "how big is this leader" read without a second table in Phase A.
  account_value_usd double precision,
  -- When the snapshot was fetched from HL (the service sets this).
  fetched_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- One current row per (leader, coin) — the service upserts on this.
  unique (leader_address, coin)
);

create table if not exists public.leader_actions (
  id              uuid primary key default gen_random_uuid(),
  leader_address  text not null,
  coin            text not null,
  kind            text not null check (kind in ('open','add','reduce','close','flip')),
  -- Side before/after the transition (null where not applicable: prev_side null
  -- on an open, new_side null on a close).
  prev_side       text check (prev_side in ('long','short')),
  new_side        text check (new_side in ('long','short')),
  -- Absolute sizes before/after + the signed change (new_size − prev_size).
  prev_size       double precision not null default 0,
  new_size        double precision not null default 0,
  size_delta      double precision not null default 0,
  -- Current entry / notional / uPnL at the moment the action was detected.
  entry_px        double precision,
  notional_usd    double precision not null default 0,
  unrealized_pnl  double precision not null default 0,
  detected_at     timestamptz not null default now()
);

-- Per-leader recent-actions index (trader-detail drawer) + a global feed index.
create index if not exists idx_leader_actions_leader on public.leader_actions (leader_address, detected_at desc);
create index if not exists idx_leader_actions_feed   on public.leader_actions (detected_at desc);
-- Rail/Leader-vs-You read positions by leader.
create index if not exists idx_leader_positions_leader on public.leader_positions (leader_address);

-- ---------------------------------------------------------------------------
-- Realtime: REPLICA IDENTITY FULL + add to the supabase_realtime publication
-- (matches 0001/0002; guarded so re-running does not error).
-- ---------------------------------------------------------------------------

alter table public.leader_positions replica identity full;
alter table public.leader_actions   replica identity full;

do $$
declare
  t text;
  tables text[] := array['leader_positions','leader_actions'];
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

alter table public.leader_positions enable row level security;
alter table public.leader_actions   enable row level security;

drop policy if exists "anon read leader_positions" on public.leader_positions;
drop policy if exists "anon read leader_actions"   on public.leader_actions;

create policy "anon read leader_positions" on public.leader_positions for select using (true);
create policy "anon read leader_actions"   on public.leader_actions   for select using (true);
