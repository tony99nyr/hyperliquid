-- Record refused event-blackout entries as counterfactual trials.
alter table public.scout_decisions
  drop constraint if exists scout_decisions_kind_check;

alter table public.scout_decisions
  add constraint scout_decisions_kind_check
  check (kind in ('open','close','propose','stand-down','error','blackout-ghost'));

alter table public.scout_decisions
  add column if not exists detail jsonb;
