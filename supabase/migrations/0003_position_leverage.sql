-- HL Cockpit — add per-position leverage (Phase 1 polish).
--
-- The bottom Active-Position bar's PnlHero shows ROE (return on equity), the
-- number a leveraged perp trader watches most. ROE = unrealizedPnl / margin,
-- where margin = notional / leverage. The position fold (applyFills) is
-- leverage-agnostic by design (ADR-0001), so leverage is stored alongside the
-- folded position as account/asset config rather than derived from fills.
--
-- Nullable: paper positions opened without an explicit leverage leave it NULL
-- and the UI falls back to showing P&L % only (ROE hidden). No backfill needed.

alter table public.positions
  add column if not exists leverage double precision;

comment on column public.positions.leverage is
  'Position leverage (e.g. 5 = 5x). NULL when unknown; UI hides ROE when null.';
