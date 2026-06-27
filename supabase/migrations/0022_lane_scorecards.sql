-- HL Cockpit — persisted per-lane scorecard snapshot for the cockpit Scout tab.
--
-- The scout's multi-lane breakdown (directional + vault + carry benchmarks) is
-- computed in lane-scorecard-service.ts. The benchmarks fetch paginated HL
-- history, so computing them on every UI poll would hammer HL — instead the
-- nas-watch tick refreshes this table (replace-all, single writer) and the
-- cockpit reads the latest snapshot cheaply. Mirrors how vault_snapshots /
-- rubric_scores are daemon-written + UI-read. See SCOUT_ALPHA_ROADMAP.md.

create table if not exists public.lane_scorecards (
  lane                  text primary key,   -- 'ALL' | 'directional' | 'vault:HLP' | 'carry'
  kind                  text not null,       -- 'account' | 'positions' | 'vault' | 'carry'
  net_usd               double precision,
  realized_usd          double precision,
  funding_usd           double precision,    -- signed (− = carry earned)
  unrealized_usd        double precision,
  trade_count           integer,
  win_rate              double precision,    -- 0..1
  monthly_run_rate_usd  double precision,
  period_days           double precision,
  verdict               text,                -- kill | continue | graduate
  label                 text,                -- human one-liner
  open_count            integer,
  detail                jsonb,               -- lane-specific extras (coin/side/apr/nav/…)
  updated_at            timestamptz not null default now()
);

-- RLS: anon SELECT only; the service-role writer (nas-watch) inserts. NOT on the
-- realtime publication (≤5-min cadence; the cockpit reads it via the scout
-- performance route on its existing poll).
alter table public.lane_scorecards enable row level security;
drop policy if exists "anon read lane_scorecards" on public.lane_scorecards;
create policy "anon read lane_scorecards" on public.lane_scorecards for select using (true);
