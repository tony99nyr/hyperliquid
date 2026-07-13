-- 0033: advisory stop price on positions — wires the scout's position-near-stop trigger.
--
-- The scout's paper entries compute a stop (buildOpenProposal.stopPx) but never
-- persisted it, so the daemon hardcoded stopPx=null and the `position-near-stop`
-- act-trigger could NEVER fire (dead code since Phase 4). This column is
-- ADVISORY metadata written by the scout paper path only:
--   - scripts/scout-trade.ts sets it after an entry fill, clears it on a full close.
--   - scout-watch-service reads it to feed the near-stop detector.
-- It does NOT place any order and is NOT read by the trading core (Position stays
-- pure/mode-agnostic; fill-persistence ignores it). NULL = no advisory stop known.

alter table public.positions add column if not exists stop_px numeric;

comment on column public.positions.stop_px is
  'Advisory stop price (scout paper lane) — feeds the position-near-stop trigger; never an order.';
