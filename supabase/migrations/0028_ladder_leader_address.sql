-- 0028_ladder_leader_address — tag a copy-thesis ladder with the leader it follows.
--
-- A ladder whose thesis is "follow wallet X" carries that address so the leader guard
-- (ladder-leader-guard-service, run from the ladder-watch cron) can AUTO-DISARM it when
-- the trader-watch feed shows the leader CLOSED or FLIPPED the coin after arming — the
-- playbook's #1 dead-zone rule ("if the copied leader exits, the reason is gone"),
-- enforced instead of remembered. DISARM-ONLY authority: the guard can never fire,
-- open, or close anything.
--
-- Additive + idempotent.

alter table public.ladders add column if not exists leader_address text;
