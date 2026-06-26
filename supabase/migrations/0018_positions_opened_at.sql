-- "held" duration for an open position. The positions row is UNIQUE(session_id,coin)
-- and reused across close/reopen, so created_at can't represent the current run.
-- opened_at is fold-derived (computeOpenedAtMs) and written on every fill upsert:
-- set to the flat→open (or flip) fill time, null when the position is flat.
alter table public.positions add column if not exists opened_at timestamptz;
