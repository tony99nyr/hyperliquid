-- HL Cockpit — rubric engine output (deterministic opportunity scoring).
--
-- The rubric scan computes, per coin×side, an opportunity score + the 4 pillar
-- sub-scores + key levels + gate states, and a per-position HOLD/ADD/TRIM/EXIT
-- review. The cockpit reads these (anon SELECT + realtime) to render the
-- Opportunity board + whale posture + chart overlays — no client HL calls.
--
-- Insert-only; the UI reads the newest row per (coin, side) by computed_at.
-- unique (coin, side, inputs_hash) dedupes identical re-runs (point-in-time).
-- Idempotent / re-runnable. Mirrors 0001/0008 RLS + realtime conventions.

create table if not exists public.rubric_scores (
  id              uuid primary key default gen_random_uuid(),
  computed_at     timestamptz not null default now(),
  as_of          timestamptz not null,
  coin            text not null,
  side            text not null check (side in ('long','short')),
  opportunity     double precision not null,
  pillar_regime   double precision not null,
  pillar_leaders  double precision not null,
  pillar_carry    double precision not null,
  pillar_micro    double precision not null,
  regime_multiplier double precision not null,
  badge           text not null,
  chosen_side     text not null,
  no_trade_reason text,
  entry_low       double precision,
  entry_high      double precision,
  invalidation    double precision,
  target          double precision,
  trigger_px      double precision,
  room_to_target  double precision,
  confidence      double precision not null default 0,
  score_band_low  double precision not null default 0,
  score_band_high double precision not null default 0,
  gates           jsonb not null default '{}'::jsonb,
  killed_by       text,
  config_version  text not null,
  inputs_hash     text not null,
  unique (coin, side, inputs_hash)
);

create table if not exists public.position_reviews (
  id             uuid primary key default gen_random_uuid(),
  computed_at    timestamptz not null default now(),
  session_id     uuid references public.sessions(id) on delete cascade,
  coin           text not null,
  side           text not null check (side in ('long','short')),
  verdict        text not null check (verdict in ('HOLD','ADD','TRIM','EXIT')),
  health_score   double precision not null,
  p_continuation double precision not null,
  p_adverse      double precision not null,
  alerts         jsonb not null default '[]'::jsonb,
  rationale      jsonb not null default '[]'::jsonb,
  config_version text not null
);

create index if not exists idx_rubric_scores_coin_side on public.rubric_scores (coin, side, computed_at desc);
create index if not exists idx_position_reviews_session_coin on public.position_reviews (session_id, coin, computed_at desc);

-- RLS: anon SELECT only; all writes via the service role (mirror 0001/0004).
alter table public.rubric_scores    enable row level security;
alter table public.position_reviews enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'rubric_scores' and policyname = 'rubric_scores_anon_select') then
    create policy rubric_scores_anon_select on public.rubric_scores for select to anon using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'position_reviews' and policyname = 'position_reviews_anon_select') then
    create policy position_reviews_anon_select on public.position_reviews for select to anon using (true);
  end if;
end $$;

-- Realtime (mirror 0001): REPLICA IDENTITY FULL + add to the publication.
alter table public.rubric_scores    replica identity full;
alter table public.position_reviews replica identity full;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rubric_scores') then
    alter publication supabase_realtime add table public.rubric_scores;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'position_reviews') then
    alter publication supabase_realtime add table public.position_reviews;
  end if;
end $$;
