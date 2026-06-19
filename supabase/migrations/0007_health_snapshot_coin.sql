-- HL Cockpit — coin-scope health snapshots (the multi-position fix).
--
-- health_snapshots was per-SESSION only, so with >1 open position the watch
-- daemon's per-coin assessments overwrote each other and the Trade Health panel
-- thrashed (showed whichever coin was written last). Adding `coin` lets each
-- open position carry its OWN health score / probabilities / alerts, and the
-- panel reads the snapshot for the selected coin (labeled "Trade Health · ETH").
--
-- Nullable: legacy (pre-0007) rows have no coin → null (treated as session-wide).
-- Idempotent / re-runnable. RLS + realtime unchanged (the table is already in the
-- supabase_realtime publication with REPLICA IDENTITY FULL from 0001).

alter table public.health_snapshots
  add column if not exists coin text;

-- Per-(session, coin) latest-first read — the panel/auto-exit fetch the newest
-- snapshot for a given coin.
create index if not exists idx_health_snapshots_session_coin
  on public.health_snapshots (session_id, coin, created_at desc);
