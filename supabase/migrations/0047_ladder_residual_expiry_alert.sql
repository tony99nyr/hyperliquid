-- Separate once-only stamp for an expired ladder with a live residual position.
alter table public.ladders add column if not exists residual_alert_at timestamptz;

-- Do not issue retrospective pages for ladders that expired before this feature.
update public.ladders
set residual_alert_at = coalesce(disarmed_at, updated_at, now())
where status = 'expired' and residual_alert_at is null;
