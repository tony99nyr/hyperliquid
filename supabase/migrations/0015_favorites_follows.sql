-- 0015_favorites_follows — copy-trading pivot data model (PR-2).
--
-- Adds the operator-global tables that drive the favorites-gated watch + the
-- follow/evaluation surfaces:
--   * favorited_traders   — the live watch-set source (daemon reads it each cycle)
--   * followed_positions  — actively-followed (leader, coin) positions (keep-matched)
--   * trader_evaluations  — persisted on-demand vetting fingerprint (dual-consumer:
--                           UI renders it, the review-trader skill reads the same row)
-- plus pending_actions.dedupe_key for follow-stage idempotency (PR-6).
--
-- Security (ADR-0002, mirrors 0004): anon may SELECT only; ALL writes are
-- service-role (cockpit write routes + the NAS daemon). These tables are NOT on
-- the supabase_realtime publication — the UI POLLS them (cheap at favorites scale,
-- and keeps the realtime-message budget for the own-position tables).
--
-- Idempotent / re-runnable.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.favorited_traders (
  leader_address text primary key,
  favorited_at   timestamptz not null default now(),
  note           text
);

create table if not exists public.followed_positions (
  id             uuid primary key default gen_random_uuid(),
  leader_address text not null,
  coin           text not null,
  status         text not null default 'active' check (status in ('active','ended')),
  followed_at    timestamptz not null default now(),
  ended_at       timestamptz,
  note           text
);
-- At most one ACTIVE follow per (leader, coin); historical ended rows are allowed.
create unique index if not exists followed_positions_active_uniq
  on public.followed_positions (leader_address, coin) where status = 'active';
create index if not exists followed_positions_active_idx
  on public.followed_positions (status) where status = 'active';

-- On-demand vetting fingerprint. `metrics` carries the RatedWalletMetrics shape so
-- the UI and the review-trader skill read ONE shape (one-evaluation-two-consumers).
-- `persistence_confidence` is the frozen enum (review A4): a verdict certifies
-- OPERATIONAL FEASIBILITY (fillable / mirrorable hold / not a martingale tail), NOT
-- forward profitability — the small-live gate (Phase 4.5) is the only profit gate.
create table if not exists public.trader_evaluations (
  id                     uuid primary key default gen_random_uuid(),
  leader_address         text not null,
  verdict                text not null check (verdict in ('follow','caution','avoid')),
  persistence_confidence text not null check (persistence_confidence in ('multi-window','single-window','insufficient')),
  metrics                jsonb not null,
  hold_distribution      jsonb,
  round_trip_series      jsonb,
  window_label           text,
  fills_seen             integer,
  generated_at           timestamptz not null default now()
);
create index if not exists trader_evaluations_leader_idx
  on public.trader_evaluations (leader_address, generated_at desc);

-- Follow-stage idempotency (PR-6): one staged matching action per detected
-- leader_action. Partial-unique so non-follow pending_actions stay unconstrained.
alter table public.pending_actions add column if not exists dedupe_key text;
create unique index if not exists pending_actions_dedupe_key_uniq
  on public.pending_actions (dedupe_key) where dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- Row Level Security: anon SELECT only; writes are service-role. NO anon
-- INSERT/UPDATE/DELETE policy (the 0013 auto_exit_locks lesson).
-- ---------------------------------------------------------------------------

alter table public.favorited_traders  enable row level security;
alter table public.followed_positions enable row level security;
alter table public.trader_evaluations enable row level security;

drop policy if exists "anon read favorited_traders"  on public.favorited_traders;
drop policy if exists "anon read followed_positions" on public.followed_positions;
drop policy if exists "anon read trader_evaluations" on public.trader_evaluations;

create policy "anon read favorited_traders"  on public.favorited_traders  for select using (true);
create policy "anon read followed_positions" on public.followed_positions for select using (true);
create policy "anon read trader_evaluations" on public.trader_evaluations for select using (true);

-- Intentionally NOT added to the supabase_realtime publication (UI polls).
