-- 0026_ladder_reduce_frac — fraction-based reduce/close sizing.
--
-- A reduce rung's `size_coins` is an ABSOLUTE coin amount, so "trim 40%" is path-dependent:
-- the realized fraction depends on which earlier entry rungs actually filled (e.g. an add
-- that the coverage gate skipped). `reduce_frac` (0,1] instead trims a FRACTION of the
-- CURRENT live position at fire time — robust to which rungs filled. The fire path prefers
-- reduce_frac, falls back to size_coins/position, else full close.
--
-- Additive + idempotent (safe to re-run).

alter table public.ladder_rungs add column if not exists reduce_frac numeric;

-- Sanity bound: a fraction in (0, 1] when present.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ladder_rungs_reduce_frac_range') then
    alter table public.ladder_rungs
      add constraint ladder_rungs_reduce_frac_range
      check (reduce_frac is null or (reduce_frac > 0 and reduce_frac <= 1));
  end if;
end $$;
