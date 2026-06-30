-- 0027_ladder_archive — soft-archive ladders (hide from the UI, KEEP for audit).
--
-- The operator wants to clear disarmed/filled ladders out of the cockpit WITHOUT losing
-- the history. `archived_at` is a soft-delete tombstone: the row (+ its rungs + its
-- ladder_fires) stays for the audit trail; the UI lists just exclude archived_at IS NOT
-- NULL by default and offer a "show archived" view. Only a NON-armed ladder can be
-- archived (an armed ladder is live authorization — never hide it). null = active/visible.
--
-- Additive + idempotent.

alter table public.ladders add column if not exists archived_at timestamptz;

-- The active-ladder lists filter on archived_at IS NULL; index the common case.
create index if not exists ladders_active_idx
  on public.ladders (created_at desc)
  where archived_at is null;
