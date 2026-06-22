-- 0010_scout_observability.sql
-- Two additive tables for the autonomous scout (post-adversarial-review):
--   * market_snapshots — a periodic time series of funding/OI/premium/leader-net
--     per coin, written by the rubric scan. The deterministic engine currently
--     uses only INSTANTANEOUS values; persisting history unblocks future
--     backtested lanes (liquidation-cascade fade, funding/OI MOMENTUM,
--     leader-de-risking) that need deltas, not snapshots. Pure data collection.
--   * scout_heartbeat — liveness. The scout daemons write nothing else a human
--     can see; this lets the cockpit show "last tick Nm ago" so a hung/dead
--     daemon (crash, OAuth expiry) is detectable instead of silently stale.
-- anon SELECT (read-only browser) + service-role writes; mirrors 0009 conventions.

create table if not exists public.market_snapshots (
  id              uuid primary key default gen_random_uuid(),
  captured_at     timestamptz not null default now(),
  coin            text not null,
  mark_px         double precision,
  funding_hourly  double precision,
  open_interest   double precision,
  premium         double precision,
  leader_net      double precision,
  config_version  text
);
create index if not exists idx_market_snapshots_coin_time on public.market_snapshots (coin, captured_at desc);

create table if not exists public.scout_heartbeat (
  source        text primary key,         -- e.g. 'scout-watch'
  last_tick_at  timestamptz not null default now(),
  status        text,                     -- 'ok' | 'degraded' | ...
  detail        text
);

alter table public.market_snapshots enable row level security;
alter table public.scout_heartbeat enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'market_snapshots' and policyname = 'market_snapshots_anon_select') then
    create policy market_snapshots_anon_select on public.market_snapshots for select to anon using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'scout_heartbeat' and policyname = 'scout_heartbeat_anon_select') then
    create policy scout_heartbeat_anon_select on public.scout_heartbeat for select to anon using (true);
  end if;
end $$;

-- Realtime only for the heartbeat (the panel reacts to it live); snapshots are
-- a query-on-demand time series, no realtime needed.
alter table public.scout_heartbeat replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'scout_heartbeat') then
    alter publication supabase_realtime add table public.scout_heartbeat;
  end if;
end $$;
