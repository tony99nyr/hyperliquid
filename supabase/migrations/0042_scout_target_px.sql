-- 0042: advisory TARGET price on positions — the mechanical reversion take-profit.
--
-- Mirrors 0033 (stop_px). The reversion-extreme lane's registered exit is a fixed
-- target (the 50%-retrace of the stretch). Persisting it here lets the scout's
-- position-at-target trigger + cycle snapshot know the level deterministically, so a
-- winner is CLOSED at target instead of held past it (which corrupts the forward
-- test's planned-R vs realized-R). Advisory only — never enters the pure P&L fold
-- (fill-persistence ignores it, ADR-0001). NULL = no target known.
alter table public.positions add column if not exists target_px numeric;

comment on column public.positions.target_px is
  'Advisory take-profit target (scout reversion lane). Read by position-at-target trigger; not part of the P&L fold.';
