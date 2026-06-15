-- HL Cockpit — initial schema (Phase 0).
--
-- Eight tables holding ALL durable cockpit state. Market data (price / book /
-- trades) is NEVER stored here — it streams to the browser over the HL
-- websocket (the other transport, ADR-0002). These tables are the source of
-- truth for a trade and are pushed to the UI via Postgres realtime.
--
-- Security model (ADR-0002):
--   * anon role  → SELECT only (the phone reads live state).
--   * writes     → service-role only (Claude's skills / server routes).
-- REPLICA IDENTITY FULL + the supabase_realtime publication enable per-row
-- realtime payloads the browser subscribes to per session.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.sessions (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  status          text not null default 'active' check (status in ('active','closed')),
  mode            text not null default 'paper'  check (mode in ('paper','live')),
  title           text,
  leader_address  text
);

create table if not exists public.positions (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.sessions(id) on delete cascade,
  coin              text not null,
  side              text not null check (side in ('long','short','flat')),
  sz                double precision not null default 0,
  avg_entry_px      double precision not null default 0,
  realized_pnl_usd  double precision not null default 0,
  fees_paid_usd     double precision not null default 0,
  updated_at        timestamptz not null default now(),
  unique (session_id, coin)
);

create table if not exists public.fills (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.sessions(id) on delete cascade,
  -- Idempotency key shared across paper/live + retries. Unique = a fill is
  -- recorded exactly once regardless of how many times executeIntent runs.
  client_intent_id  text not null unique,
  coin              text not null,
  side              text not null check (side in ('buy','sell')),
  px                double precision not null,
  sz                double precision not null,
  notional_usd      double precision not null,
  fee_usd           double precision not null default 0,
  reduce_only       boolean not null default false,
  partial           boolean not null default false,
  -- Recorded for audit ONLY — application code never branches on it.
  source            text not null check (source in ('paper','live')),
  hl_order_id       text,
  hl_raw            jsonb,
  filled_at         timestamptz not null default now()
);

create table if not exists public.pnl (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.sessions(id) on delete cascade,
  coin              text not null,
  realized_pnl_usd  double precision not null default 0,
  unrealized_pnl_usd double precision not null default 0,
  fees_paid_usd     double precision not null default 0,
  mark_px           double precision,
  created_at        timestamptz not null default now()
);

create table if not exists public.analysis_log (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions(id) on delete cascade,
  created_at  timestamptz not null default now(),
  source      text not null,
  severity    text not null default 'info' check (severity in ('info','warn','danger')),
  message     text not null
);

create table if not exists public.hypotheses (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references public.sessions(id) on delete cascade,
  created_at       timestamptz not null default now(),
  statement        text not null,
  status           text not null default 'open' check (status in ('open','confirmed','invalidated','resolved')),
  resolved_at      timestamptz,
  resolution_note  text
);

create table if not exists public.health_snapshots (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.sessions(id) on delete cascade,
  created_at      timestamptz not null default now(),
  score           double precision not null check (score >= 0 and score <= 100),
  p_continuation  double precision not null,
  p_adverse       double precision not null,
  alerts          jsonb not null default '[]'::jsonb
);

create table if not exists public.context_gauge (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions(id) on delete cascade,
  created_at  timestamptz not null default now(),
  approx_pct  double precision not null check (approx_pct >= 0 and approx_pct <= 100),
  zone        text not null check (zone in ('ok','warn','critical'))
);

-- Helpful per-session ordering indexes for the realtime UI streams.
create index if not exists idx_analysis_log_session    on public.analysis_log (session_id, created_at desc);
create index if not exists idx_health_snapshots_session on public.health_snapshots (session_id, created_at desc);
create index if not exists idx_context_gauge_session    on public.context_gauge (session_id, created_at desc);
create index if not exists idx_fills_session            on public.fills (session_id, filled_at desc);
create index if not exists idx_hypotheses_session       on public.hypotheses (session_id, created_at desc);
create index if not exists idx_pnl_session              on public.pnl (session_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Realtime: REPLICA IDENTITY FULL so UPDATE/DELETE payloads carry old + new
-- row data, and add every table to the supabase_realtime publication.
-- ---------------------------------------------------------------------------

alter table public.sessions         replica identity full;
alter table public.positions        replica identity full;
alter table public.fills            replica identity full;
alter table public.pnl              replica identity full;
alter table public.analysis_log     replica identity full;
alter table public.hypotheses       replica identity full;
alter table public.health_snapshots replica identity full;
alter table public.context_gauge    replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;

alter publication supabase_realtime add table public.sessions;
alter publication supabase_realtime add table public.positions;
alter publication supabase_realtime add table public.fills;
alter publication supabase_realtime add table public.pnl;
alter publication supabase_realtime add table public.analysis_log;
alter publication supabase_realtime add table public.hypotheses;
alter publication supabase_realtime add table public.health_snapshots;
alter publication supabase_realtime add table public.context_gauge;

-- ---------------------------------------------------------------------------
-- Row Level Security: anon may SELECT only; all writes require service-role
-- (which bypasses RLS). No INSERT/UPDATE/DELETE policies are granted to anon,
-- so those operations are denied for the anon/browser client by default.
-- ---------------------------------------------------------------------------

alter table public.sessions         enable row level security;
alter table public.positions        enable row level security;
alter table public.fills            enable row level security;
alter table public.pnl              enable row level security;
alter table public.analysis_log     enable row level security;
alter table public.hypotheses       enable row level security;
alter table public.health_snapshots enable row level security;
alter table public.context_gauge    enable row level security;

create policy "anon read sessions"         on public.sessions         for select using (true);
create policy "anon read positions"        on public.positions        for select using (true);
create policy "anon read fills"            on public.fills            for select using (true);
create policy "anon read pnl"              on public.pnl              for select using (true);
create policy "anon read analysis_log"     on public.analysis_log     for select using (true);
create policy "anon read hypotheses"       on public.hypotheses       for select using (true);
create policy "anon read health_snapshots" on public.health_snapshots for select using (true);
create policy "anon read context_gauge"    on public.context_gauge    for select using (true);
