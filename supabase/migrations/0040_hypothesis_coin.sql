-- 0040: hypotheses.coin — the missing per-coin link.
--
-- The scout's close path resolved a hypothesis only when the model REMEMBERED to
-- pass hypothesisId in its close decision (scout-trade runExit). When it forgot,
-- the position closed but the hypothesis orphaned (status stayed 'open'), so the
-- per-setup expectancy silently missed the outcome (a HYPE reversion loss, Jul-21).
-- A coin column lets the close resolve the OPEN hypothesis for (session, coin)
-- deterministically, id or no id.
alter table public.hypotheses add column if not exists coin text;
