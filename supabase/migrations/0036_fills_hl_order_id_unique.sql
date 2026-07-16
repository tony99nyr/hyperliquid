-- 0036: one fills row per HL order — hard double-book protection.
--
-- The exchange-fill backfill (reconcile cron) dedupes by hl_order_id with a
-- read-then-write SELECT, which races the fire path booking the same order via
-- executeIntent (~0.5–2s between HL execution and the persistFillRow commit).
-- Both writers passing the read simultaneously would insert two rows for one
-- real order and the position fold would double-count size and realized P&L —
-- silently and permanently. This partial unique index makes the second insert
-- fail with 23505, which persistFillRow already treats as "already recorded"
-- (idempotent). Paper fills carry NULL hl_order_id and are exempt.
--
-- Known trade-off (documented in fill-backfill-business-logic.ts): a resting
-- order that fills in several partials across cron ticks can only ever book
-- ONE row; the backfill detects the size shortfall and alerts instead of
-- inserting a second row for the same oid.
create unique index if not exists fills_hl_order_id_uniq
  on public.fills (hl_order_id)
  where hl_order_id is not null;
