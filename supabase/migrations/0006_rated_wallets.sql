-- HL Cockpit — rated_wallets: the weekly wallet rankings in Supabase.
--
-- The weekly re-rank pipeline (iamrossi/HL `weekly-rerank.sh`) regenerates the
-- rankings and UPSERTS them here, so the cockpit UI + Claude's skills read live
-- rankings from Supabase instead of a git-committed JSON (no manual `git pull`,
-- no Vercel redeploy to refresh). The always-on trade-watch daemon keeps reading
-- the LOCAL rated-wallets.json (its leader-selection runs every ~30s and must not
-- gain a network call — see ADR notes / the trade-watch hot loop).
--
-- ATOMIC GENERATION SWAP (so a reader never sees a half-written re-rank):
--   * Each run writes all wallet rows tagged with a NEW `generation` (epoch-ms).
--   * Only after every row is in does it flip `rated_wallets_meta.active_generation`
--     to the new value — a single-row update = the atomic cutover.
--   * Readers select rows WHERE generation = (meta.active_generation), so they see
--     EITHER the whole old generation or the whole new one, never a mix.
--   * Old generations are then deleted as cleanup.
--
-- NOT realtime: rankings change WEEKLY, not live — so (unlike leader_positions)
-- this table is NOT added to the supabase_realtime publication and does NOT get
-- REPLICA IDENTITY FULL. A weekly bulk rewrite would otherwise spam ~1600 change
-- events to every browser for data the UI reads once per load.
--
-- Security (ADR-0002, like 0001/0004): anon → SELECT only; writes are service-role.
-- Idempotent / re-runnable.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.rated_wallets (
  id                uuid primary key default gen_random_uuid(),
  -- Epoch-ms tag identifying the re-rank run this row belongs to.
  generation        bigint not null,
  address           text not null,
  short             text not null,
  display_name      text,
  composite         double precision,
  -- Per-philosophy grades {philosophy: {grade, score10}} — sparse open map.
  grades            jsonb not null default '{}'::jsonb,
  -- The full metrics bundle (sharpe/winRate/profitFactor/…).
  metrics           jsonb not null default '{}'::jsonb,
  flags             text[] not null default '{}',
  sources           text[] not null default '{}',
  -- EDT trading-hours profile (hourHistogramEdt[24] etc.), or null.
  trading_activity  jsonb,
  leaderboard_top   boolean not null default false,
  anticipation_label text,
  top_coins         text[] not null default '{}',
  worst_open        jsonb,
  unique (generation, address)
);

-- One ranking read = "rows of the active generation, ordered by composite".
create index if not exists idx_rated_wallets_gen_composite
  on public.rated_wallets (generation, composite desc nulls last);

-- Singleton metadata row (id is pinned to 1) — carries the active generation +
-- the dataset-level fields the UI needs (watch window, philosophies, etc.).
create table if not exists public.rated_wallets_meta (
  id                 int primary key default 1 check (id = 1),
  active_generation  bigint,
  schema_version     int not null default 1,
  description        text,
  philosophies       text[] not null default '{}',
  watch_window_edt   jsonb,
  known_flags        text[] not null default '{}',
  count              int not null default 0,
  generated_at       timestamptz,
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security: anon may SELECT only; writes require service-role.
-- (Deliberately NOT added to supabase_realtime — weekly data, see header.)
-- ---------------------------------------------------------------------------

alter table public.rated_wallets      enable row level security;
alter table public.rated_wallets_meta enable row level security;

drop policy if exists "anon read rated_wallets"      on public.rated_wallets;
drop policy if exists "anon read rated_wallets_meta" on public.rated_wallets_meta;

create policy "anon read rated_wallets"      on public.rated_wallets      for select using (true);
create policy "anon read rated_wallets_meta" on public.rated_wallets_meta for select using (true);
