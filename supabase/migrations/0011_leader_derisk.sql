-- 0011_leader_derisk.sql
-- Add the per-coin leader de-risk signal to the market-snapshots time series so it
-- ACCUMULATES for backtesting. It's computed from the recent leader-action stream
-- (size leaving vs entering among tracked leaders) by the rubric scan. The rubric
-- veto that will consume it ships config-gated OFF until a backtest validates it —
-- this column is pure forward data collection. Additive; no RLS/realtime changes
-- (market_snapshots already has anon-SELECT from 0010).

alter table public.market_snapshots add column if not exists leader_derisk double precision;
