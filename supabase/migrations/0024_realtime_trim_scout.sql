-- 0024_realtime_trim_scout — second realtime-egress trim (sustain the FREE tier).
--
-- After 0014 dropped the leader feeds, the remaining Realtime-message + egress driver
-- is the SCOUT/ADVISORY churn: the scout daemon re-upserts rubric_scores (many coin×side
-- rows), health_snapshots, a heartbeat, and hypotheses EVERY cycle, and each change fires
-- a realtime message to every open cockpit/scout tab. None of these need sub-second push —
-- they are monitoring/advisory reads. Drop them from the publication so their consumers
-- (useRubricScores / useHealthSnapshots / useScoutHeartbeat / useScoutHypotheses, all of
-- which already carry useRealtimeChannel's ~60s snapshot-refetch fallback) degrade
-- GRACEFULLY to polling — fully functional, just not sub-second.
--
-- KEPT on realtime (own-position / approval / risk — must be INSTANT, and only change
-- when the operator actually trades, so near-zero churn): positions, pnl, fills,
-- pending_actions, safe_exit_plan, sessions, circuit_breaker_state.
--
-- Idempotent / re-runnable: only drops a table when it is currently a member.

do $$
declare
  t text;
  drop_tables text[] := array['rubric_scores', 'health_snapshots', 'scout_heartbeat', 'hypotheses', 'position_reviews'];
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array drop_tables loop
      if exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime drop table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
