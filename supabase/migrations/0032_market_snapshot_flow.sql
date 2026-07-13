-- 0032_market_snapshot_flow — extend the market time series with tape + buyback gauges.
--
-- taker_flow: CVD-style aggressor skew from the recent tape, [-1,1] (+ = net buying).
-- book_imbalance: resting bid/ask notional skew within the depth band, [-1,1].
-- af_hype_balance: the Assistance Fund's HYPE spot balance (HYPE rows only) — its delta
-- over time is the fee-funded buyback run-rate, the structural-bid gauge our research
-- showed is procyclical (NOT a floor). Recorded so the claim becomes measurable.
--
-- Additive + idempotent.

alter table public.market_snapshots add column if not exists taker_flow double precision;
alter table public.market_snapshots add column if not exists book_imbalance double precision;
alter table public.market_snapshots add column if not exists af_hype_balance double precision;
