-- 0041: hypothesis open-baseline for contamination-free round-trip P&L.
--
-- The scout reuses ONE long-lived session and re-enters the same coin, so the
-- positions row's realized_pnl_usd / fees_paid_usd are CUMULATIVE across every
-- trip on that (session, coin) and are never reset. Resolving a close from the
-- raw cumulative would bake a PRIOR trip's P&L into THIS trip's hypothesis
-- (winner/loser flip — the same ledger corruption the per-leg math had in the
-- other direction). Snapshotting realized/fees at OPEN lets the close resolve on
-- the DELTA — this trip's net, partials included, no cross-trip bleed.
--
-- Nullable + idempotent: legacy rows (opened before this column existed) resolve
-- via the single-leg fallback, which is correct for their full closes.
alter table public.hypotheses add column if not exists realized_at_open_usd double precision;
alter table public.hypotheses add column if not exists fees_at_open_usd double precision;
