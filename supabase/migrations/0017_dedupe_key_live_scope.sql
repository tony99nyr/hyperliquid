-- 0017_dedupe_key_live_scope — narrow the follow-match idempotency index (PR-6).
--
-- 0015's pending_actions.dedupe_key unique index spanned ALL statuses, so a match the
-- operator DISMISSED (status='rejected') permanently blocked re-staging that same
-- leader event (safety audit MEDIUM-1). Scope the uniqueness to live/acted rows only:
-- a rejected/expired stage frees the key so a mistakenly-dismissed match can be
-- re-raised, while an in-flight (preview/executing) or already-acted (executed) stage
-- still can't be duplicated. Idempotent / re-runnable.

drop index if exists public.pending_actions_dedupe_key_uniq;
create unique index if not exists pending_actions_dedupe_key_uniq
  on public.pending_actions (dedupe_key)
  where dedupe_key is not null and status <> 'rejected' and status <> 'expired';
