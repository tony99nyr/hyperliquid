-- HL Cockpit — add per-position strategy LANE tag (scout multi-lane refactor).
--
-- The scout is being repointed from one directional book to several lanes
-- (vault allocation, funding carry, …) sharing ONE paper book + one circuit
-- breaker (see docs/scout/SCOUT_ALPHA_ROADMAP.md, Pre-work #0). A nullable `lane`
-- tag on the positions row lets the per-lane scorecard group a single book by
-- lane WITHOUT one-session-per-lane.
--
-- METADATA, exactly like `leverage` (0003): set from the opening intent, never
-- folded into the leverage-agnostic P&L (ADR-0001), preserved across reduce-only
-- re-folds (buildPositionRow omits the column when undefined). NULL for the
-- operator/live books, which are not lane-scoped. No backfill needed.

alter table public.positions
  add column if not exists lane text;

comment on column public.positions.lane is
  'Strategy lane (scout multi-lane: e.g. vault | carry | directional). NULL for non-lane-scoped (operator/live) books. Metadata — never folded into P&L.';

-- Per-lane scorecard reads filter (session_id, lane); a partial index keeps that
-- grouping cheap without bloating the unrelated operator/live rows (lane IS NULL).
create index if not exists idx_positions_session_lane
  on public.positions (session_id, lane)
  where lane is not null;
