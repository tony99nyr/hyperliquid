-- 0023_armed_ladders — the Armed Ladder data model (P1 foundation).
--
-- An "armed ladder" is an operator-authored, multi-rung execution plan: a thesis
-- plus a set of rungs (per-coin {deterministic trigger → pre-authorized order}),
-- reviewed in the preview/arm modal and ARMED with one typed-phrase approval. A
-- deterministic watcher then fires each pre-agreed rung when its condition hits.
-- This migration is the persistence layer ONLY — no live wiring; the fire route +
-- watcher land in later P1 slices, behind LADDER_LIVE_ENABLED (gated OFF), paper-first.
--
--   * ladders       — the plan (author/mode/status/caps/expiry/precondition snapshot)
--   * ladder_rungs  — each pre-authorized order (trigger + size/risk + stop/target)
--   * ladder_fires  — the idempotent fire ledger (one row per rung; dedupe_key unique)
--
-- SAFETY — DB-enforced scout/live boundary (architecture invariant §3.6): a Postgres
-- CHECK pins `author='scout' ⇒ mode='paper' AND status<>'armed'`. App-layer alone is
-- not enough — a bug or a shared upsert MUST be stopped at the database. Only the
-- operator arm route (admin + typed-phrase, service-role) may flip status→'armed' or
-- mode→'live', and the fire route re-reads author/mode server-side from the persisted
-- row (never the request) and refuses any author='scout' ladder.
--
-- Security (mirrors 0015/0004): anon may SELECT only; ALL writes are service-role
-- (cockpit arm/author routes + the NAS watcher poke → Vercel). NOT on the
-- supabase_realtime publication — the UI polls (ladders are low-volume).
--
-- Idempotent / re-runnable.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.ladders (
  id                      uuid primary key default gen_random_uuid(),
  title                   text not null,
  thesis                  text,
  -- WHO authored it. The scout may PROPOSE (paper) but never arm/fire live.
  author                  text not null default 'operator' check (author in ('operator','scout')),
  -- paper = simulated; live = real money. A scout-authored ladder can never be live.
  mode                    text not null default 'paper'    check (mode in ('paper','live')),
  -- draft → armed (operator arm) → disarmed | done | expired. Only the arm route
  -- (admin + typed-phrase) sets 'armed'.
  status                  text not null default 'draft'    check (status in ('draft','armed','disarmed','done','expired')),
  -- Arm-time snapshot hash (invariant §3.7): live position state (side/existence/
  -- per-coin leverage) at arm. The fire route re-checks; any drift → auto-disarm.
  precondition_hash       text,
  -- Portfolio caps (invariant §3.2/§3.5) — enforced under one ladder-wide lock at fire.
  max_total_notional_usd  numeric,
  max_total_loss_usd      numeric,
  -- Ladders EXPIRE — an armed plan is not open-ended authorization.
  expires_at              timestamptz,
  armed_at                timestamptz,
  disarmed_at             timestamptz,
  disarm_reason           text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- INVARIANT §3.6 (DB backstop): a scout-authored ladder is ALWAYS paper and can
  -- NEVER be armed. The operator arm route clones a scout proposal into an
  -- operator-authored row before arming; it never flips author='scout' to live/armed.
  constraint ladders_scout_is_paper_unarmed
    check (author <> 'scout' or (mode = 'paper' and status <> 'armed'))
);
create index if not exists ladders_status_idx on public.ladders (status) where status = 'armed';
create index if not exists ladders_author_mode_idx on public.ladders (author, mode);

create table if not exists public.ladder_rungs (
  id            uuid primary key default gen_random_uuid(),
  ladder_id     uuid not null references public.ladders (id) on delete cascade,
  seq           integer not null,                    -- order within the ladder
  coin          text not null,
  side          text not null check (side in ('long','short')),
  -- what the rung DOES when it fires (open/add increase exposure; reduce/close decrease).
  action        text not null check (action in ('open','add','reduce','close')),
  -- the deterministic trigger. price_above/below are native HL-expressible; the rest
  -- need the watcher (HL triggers are price-on-mark only). Evaluated on COMPLETED candles.
  trigger_kind  text not null check (trigger_kind in ('price_above','price_below','volume','funding','indicator')),
  trigger_px    numeric,                             -- for price_above/price_below
  trigger_meta  jsonb,                               -- volume/funding/indicator params
  -- sizing: either an explicit size, or risk-based (risk_usd + stop_frac, server-sized).
  size_coins    numeric,
  risk_usd      numeric,
  stop_frac     numeric,
  leverage      integer,
  -- the protective bracket this rung rests atomically with its fill (invariant §3.3).
  stop_px       numeric,
  target_px     numeric,
  status        text not null default 'pending' check (status in ('pending','fired','skipped','failed','cancelled')),
  -- deterministic per-rung client order id (= ladderId:rungId) → exchange-level
  -- double-fire rejection (invariant: idempotent). Set at arm.
  cloid         text,
  created_at    timestamptz not null default now()
);
-- seq is a STABLE per-ladder ordinal — unique within a ladder.
create unique index if not exists ladder_rungs_seq_uniq on public.ladder_rungs (ladder_id, seq);
create index if not exists ladder_rungs_pending_idx on public.ladder_rungs (ladder_id) where status = 'pending';
-- Belt-and-suspenders on the deterministic cloid (= ladderId:rungId): the real
-- double-fire backbone is ladder_fires.dedupe_key, but a unique cloid hardens the
-- exchange-level claim. Partial (cloid is null until arm).
create unique index if not exists ladder_rungs_cloid_uniq on public.ladder_rungs (cloid) where cloid is not null;

-- The idempotent fire ledger: exactly ONE row per rung-fire attempt. The unique
-- dedupe_key (= ladderId:rungId) collapses the claim + lock + double-fire guard into
-- a single INSERT-on-conflict (mirrors pending_actions.dedupe_key / auto_exit_locks).
--
-- ONE-SHOT semantics (DELIBERATE divergence from 0017's retry-friendly partial index):
-- dedupe_key is unique across ALL statuses INCLUDING 'failed'. A rung that fails to
-- fire (e.g. stop-reject → flatten) is NOT silently auto-retried by the watcher — a
-- failed real-money fire surfaces to the operator, who re-arms a fresh ladder. Auto-
-- retrying a failed live fire is the dangerous default we explicitly avoid.
create table if not exists public.ladder_fires (
  id          uuid primary key default gen_random_uuid(),
  ladder_id   uuid not null references public.ladders (id)      on delete cascade,
  rung_id     uuid not null references public.ladder_rungs (id) on delete cascade,
  dedupe_key  text not null,                          -- ladderId:rungId — one fire per rung
  status      text not null default 'claimed' check (status in ('claimed','filled','failed','flattened')),
  detail      text,
  fired_at    timestamptz not null default now()
);
create unique index if not exists ladder_fires_dedupe_key_uniq on public.ladder_fires (dedupe_key);
create index if not exists ladder_fires_ladder_idx on public.ladder_fires (ladder_id, fired_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security: anon SELECT only; ALL writes service-role. NO anon
-- INSERT/UPDATE/DELETE policy (the 0013 auto_exit_locks lesson).
-- ---------------------------------------------------------------------------

alter table public.ladders      enable row level security;
alter table public.ladder_rungs enable row level security;
alter table public.ladder_fires enable row level security;

drop policy if exists "anon read ladders"      on public.ladders;
drop policy if exists "anon read ladder_rungs" on public.ladder_rungs;
drop policy if exists "anon read ladder_fires" on public.ladder_fires;

create policy "anon read ladders"      on public.ladders      for select using (true);
create policy "anon read ladder_rungs" on public.ladder_rungs for select using (true);
create policy "anon read ladder_fires" on public.ladder_fires for select using (true);

-- Intentionally NOT added to the supabase_realtime publication (UI polls).
