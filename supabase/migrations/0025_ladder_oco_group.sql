-- 0025 — Armed Ladder OCO groups (one-cancels-other across ladders).
--
-- A straddle ("win on a move either direction") is TWO ladders — a long-breakout and a
-- short-breakdown — because the §3.5 validator forbids long+short rungs on one coin (HL
-- nets per coin). To make that hands-off, ladders sharing an `oco_group_id` are mutually
-- exclusive: the FIRST ladder in the group to fire a rung auto-disarms every other ARMED
-- ladder in the group (the fire path calls disarmOcoSiblings).
--
-- SAFETY: the OCO action only ever DISARMS (removes authorization) — it can never open,
-- add, or move money. A bug at worst makes you miss a fire; it can never cause a loss.
-- null = no group (the default; an unlinked ladder behaves exactly as before).

alter table public.ladders
  add column if not exists oco_group_id uuid;

-- The fire path looks up armed siblings by group; index it (partial — most ladders are ungrouped).
create index if not exists ladders_oco_group_idx
  on public.ladders (oco_group_id)
  where oco_group_id is not null;
