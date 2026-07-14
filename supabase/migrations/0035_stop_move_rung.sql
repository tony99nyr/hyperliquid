-- 0035: the `stop_move` rung action — ratchet the resting stop when a price trigger hits.
--
-- The desk's most profitable manual habit (move-to-breakeven after bank-1, structural
-- trails) becomes a pre-authorized rung: when the trigger price prints on a completed
-- candle, the watcher moves the position's RESTING exchange stop to triggerMeta.moveTo
-- (a price, or 'breakeven' = the live avg entry). RISK-REDUCING ONLY, enforced at arm
-- AND fire: the new stop must be tighter than the old one and on the correct side of
-- the mark. A stop_move rung never places an entry/exit order — it only re-locates
-- protection that already exists (or adds protection where none rests).

alter table public.ladder_rungs drop constraint if exists ladder_rungs_action_check;
alter table public.ladder_rungs add constraint ladder_rungs_action_check
  check (action in ('open','add','reduce','close','stop_move'));
