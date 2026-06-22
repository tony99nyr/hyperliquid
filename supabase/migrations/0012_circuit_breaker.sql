-- 0012_circuit_breaker.sql
-- Account-level circuit-breaker state (the portfolio brake the risk review flagged
-- as the #1 missing control). One row per scope (e.g. 'scout'): the rolling peak +
-- day-start equity the breaker measures daily-loss / drawdown against, plus the
-- last decision for the cockpit to surface. Service-role writes; anon SELECT so
-- the UI can show the breaker status. Mirrors 0009/0010 conventions.

create table if not exists public.circuit_breaker_state (
  scope               text primary key,        -- 'scout' (paper account) | future scopes
  equity_usd          double precision not null default 0,
  peak_equity_usd     double precision not null default 0,
  day_start_equity_usd double precision not null default 0,
  day_start_at        timestamptz not null default now(),
  halted              boolean not null default false,
  tripped             text,                     -- 'daily-loss' | 'drawdown' | null
  reason              text,
  updated_at          timestamptz not null default now()
);

alter table public.circuit_breaker_state enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'circuit_breaker_state' and policyname = 'circuit_breaker_state_anon_select') then
    create policy circuit_breaker_state_anon_select on public.circuit_breaker_state for select to anon using (true);
  end if;
end $$;

alter table public.circuit_breaker_state replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'circuit_breaker_state') then
    alter publication supabase_realtime add table public.circuit_breaker_state;
  end if;
end $$;
