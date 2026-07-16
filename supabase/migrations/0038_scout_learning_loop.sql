-- 0038: scout learning loop — make the feedback cycle measurable (Jul-16 deep review).
--
-- The review found the loop doesn't compound: decisions unlogged (stand-downs are
-- trials — an unlogged search makes the record uninterpretable, Bailey/López de
-- Prado), hypotheses unstructured (no risk/setup/R), 4 janitorial rows poisoning
-- win-rate, scout-review never persisted, and consumer outages invisible.
--
-- 1) hypotheses: structured outcome fields (mirrors the human lane's
--    ladder_outcomes discipline) + a quarantine flag for non-trade rows.
alter table public.hypotheses add column if not exists risk_usd          double precision;
alter table public.hypotheses add column if not exists setup_type        text;
alter table public.hypotheses add column if not exists regime            text;
alter table public.hypotheses add column if not exists realized_pnl_usd  double precision;
alter table public.hypotheses add column if not exists realized_r        double precision;
-- excluded=true ⇒ janitorial/reaped row: keep for audit, exclude from ALL
-- win-rate/expectancy math (they are not resolved trades).
alter table public.hypotheses add column if not exists excluded          boolean not null default false;

-- 2) scout_decisions: the TRIAL LEDGER. One row per headless cycle decision —
--    including stand-downs and parse errors. Append-only, informational; no
--    execution path reads it.
create table if not exists public.scout_decisions (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('open','close','propose','stand-down','error')),
  coin        text,
  lane        text,
  reasoning   text not null default '',
  session_id  uuid,
  executed    boolean not null default false
);
create index if not exists idx_scout_decisions_created on public.scout_decisions (created_at desc);
alter table public.scout_decisions enable row level security;
drop policy if exists scout_decisions_select on public.scout_decisions;
create policy scout_decisions_select on public.scout_decisions for select using (true);

-- 3) scout_reviews: the judge's persisted record — one row per scout-review run
--    (the review found the judge had NEVER run; now a run leaves evidence).
create table if not exists public.scout_reviews (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  verdict      text not null,
  trade_count  integer not null default 0,
  net_usd      double precision not null default 0,
  report       text not null default ''
);
alter table public.scout_reviews enable row level security;
drop policy if exists scout_reviews_select on public.scout_reviews;
create policy scout_reviews_select on public.scout_reviews for select using (true);

-- 4) scout_heartbeat: staleness-alert bookkeeping (6h re-alert cooldown lives in
--    the row so the server-side checker is stateless).
alter table public.scout_heartbeat add column if not exists stale_alerted_at timestamptz;
