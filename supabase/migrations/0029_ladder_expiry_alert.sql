-- 0029_ladder_expiry_alert — once-only dedupe stamp for the expiry-approaching alert.
--
-- An ARMED ladder with pending rungs and <12h to expiry pages the operator ONCE
-- (Discord + analysis_log): either the window was too short / the level wrong (re-arm
-- longer), or letting it die is the plan — but it should never expire silently (the
-- 2026-07-01 ETH straddle lesson: both legs expired unfired with no signal). The stamp
-- records that the alert went out so the cron never re-pages.
--
-- Additive + idempotent.

alter table public.ladders add column if not exists expiry_alert_at timestamptz;
