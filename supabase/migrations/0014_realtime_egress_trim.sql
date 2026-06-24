-- 0014_realtime_egress_trim — stop high-churn data-feed tables from broadcasting
-- over Supabase Realtime. These were the dominant source of the Realtime-message +
-- egress blowout: the trader-watch daemon re-upserts ~50 leaders' books every poll
-- cycle, and leader_actions is append-only (~380k rows) — each row change fired a
-- realtime message to the open cockpit (~6M+/month).
--
-- The cockpit hooks that read these (useLeaderPositionsScoped / the rail / Leader-
-- vs-You / Has-position filter) already poll a periodic snapshot refetch, so they
-- degrade GRACEFULLY to polling (≈60s) with NO push — fully functional, just not
-- sub-second. The user's OWN-position tables (positions, pnl, pending_actions,
-- safe_exit_plan, sessions, …) stay on realtime so approvals + live P&L are instant.
--
-- Idempotent / re-runnable: only drops a table when it is currently a member.

do $$
declare
  t text;
  drop_tables text[] := array['leader_positions', 'leader_actions', 'context_gauge'];
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
