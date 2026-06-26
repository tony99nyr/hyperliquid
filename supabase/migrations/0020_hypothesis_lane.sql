-- HL Cockpit — add strategy LANE tag to hypotheses (scout multi-lane scorecard).
--
-- Companion to 0019 (positions.lane). The per-lane scorecard needs win/loss
-- attributed by lane, but a hypothesis carries no coin, so a lane cannot be
-- inferred — it must be stamped at write time (scout-trade --lane). Realized P&L
-- groups by positions.lane; funding is attributed per-lane via a coin->lane map
-- from positions; ONLY win/loss requires this column. See
-- docs/scout/SCOUT_ALPHA_ROADMAP.md (Pre-work #0).
--
-- Nullable: pre-refactor hypotheses + non-lane-scoped books leave it NULL. The
-- scorecard folds NULL into the legacy 'directional' lane. No backfill needed.

alter table public.hypotheses
  add column if not exists lane text;

comment on column public.hypotheses.lane is
  'Strategy lane (scout multi-lane: vault | carry | directional). NULL → folded into the directional lane by the scorecard.';

create index if not exists idx_hypotheses_session_lane
  on public.hypotheses (session_id, lane)
  where lane is not null;
