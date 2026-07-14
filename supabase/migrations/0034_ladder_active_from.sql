-- 0034: optional ACTIVATION WINDOW for armed ladders (operator request, Jul 14).
--
-- `active_from` = the earliest moment an ARMED ladder's triggers may evaluate/fire.
-- NULL = active immediately on arm (existing behavior, unchanged). With it set, the
-- operator can arm an event straddle HOURS ahead (e.g. at dinner for an 8:30 ET
-- print) and the ladder only goes hot inside [active_from, expires_at] — no pre-print
-- wander through the gates, no 5am arming. PURELY RESTRICTIVE: the window can only
-- PREVENT fires, never cause one. Enforced in the watcher (skip) AND the fire path
-- (precondition refuse — defense in depth).

alter table public.ladders add column if not exists active_from timestamptz;

comment on column public.ladders.active_from is
  'Earliest evaluation/fire time for an armed ladder; NULL = active immediately on arm.';
