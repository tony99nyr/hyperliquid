-- 0030_ladder_thesis_scores — persist the judgment pillar onto the ladder.
--
-- review-ladder scores a thesis (signal/timing 0-10, operator-supplied or rubric-auto)
-- but the scores lived only in the terminal output — so the outcome ledger could never
-- answer the most valuable question it exists for: "do my high-signal trades actually
-- win more?" Now the latest review persists them here, and ladder-expectancy resolves
-- them into ladder_outcomes. Skill-layer metadata: deliberately NOT on the engine's
-- Ladder type/contract — the fire path never reads these.
--
-- Additive + idempotent.

alter table public.ladders add column if not exists signal_score numeric;
alter table public.ladders add column if not exists timing_score numeric;
alter table public.ladders add column if not exists signal_source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ladders_signal_score_range') then
    alter table public.ladders add constraint ladders_signal_score_range
      check (signal_score is null or (signal_score >= 0 and signal_score <= 10));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ladders_timing_score_range') then
    alter table public.ladders add constraint ladders_timing_score_range
      check (timing_score is null or (timing_score >= 0 and timing_score <= 10));
  end if;
end $$;
