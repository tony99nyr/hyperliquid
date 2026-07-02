-- 0027_ladder_outcomes — the operator-lane OUTCOME LEDGER (expectancy feedback loop).
--
-- The scout lane has resolved hypotheses + a weekly scorecard (ADR-0005); the OPERATOR
-- ladder lane had nothing — no record of planned-R vs realized-R, so no way to know which
-- setups pay. One row per terminal ladder: what was planned (slip-aware risk, setup type,
-- thesis scores) vs what happened (HL realized PnL, R-multiple, classification). The weekly
-- expectancy review (skill:ladder-expectancy) reads this to KILL / HOLD / SIZE-UP setups
-- against a pre-registered bar.
--
-- Advisory data: written by the resolve script (service role), anon SELECT for the cockpit.
-- Not in the realtime publication (low volume; the UI can poll).
--
-- Idempotent / re-runnable.

create table if not exists public.ladder_outcomes (
  id                 uuid primary key default gen_random_uuid(),
  -- One outcome per ladder (upsert key).
  ladder_id          uuid not null unique references public.ladders (id) on delete cascade,
  title              text not null,
  coin               text not null,
  side               text not null check (side in ('long','short')),
  mode               text not null check (mode in ('paper','live')),
  -- Derived setup tag (e.g. 'breakout-pyramid', 'breakout-single', 'breakdown-pyramid').
  setup_type         text not null,
  -- Thesis scores at/after arm (0-10; null = never scored — an owed discipline).
  signal_score       numeric,
  timing_score       numeric,
  -- Planned: the engine's slip-aware NO-NETTING worst case at resolve (consent math).
  planned_risk_usd   double precision not null,
  -- Realized: Σ HL closedPnl (net of fees when available) for the coin over the window.
  realized_pnl_usd   double precision,
  fees_usd           double precision,
  realized_r         double precision,
  -- Classification: never_filled (no entry fired — costless selectivity), open (position
  -- still live — not yet resolvable), won / lost / scratch (closed).
  outcome            text not null check (outcome in ('never_filled','open','won','lost','scratch')),
  window_start       timestamptz not null,
  window_end         timestamptz,
  resolved_at        timestamptz not null default now(),
  notes              text
);

create index if not exists ladder_outcomes_setup_idx on public.ladder_outcomes (setup_type, resolved_at desc);

alter table public.ladder_outcomes enable row level security;
drop policy if exists "anon read ladder_outcomes" on public.ladder_outcomes;
create policy "anon read ladder_outcomes" on public.ladder_outcomes for select using (true);
-- No INSERT/UPDATE/DELETE policies — writes are service-role only (the 0013 lesson).
