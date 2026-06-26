-- HL Cockpit — vault NAV snapshots (scout Lane A: vault allocation).
--
-- The vault-watch daemon polls HL's `vaultDetails` (HLP first; operator vaults
-- later) and appends a NAV snapshot here. Lane A "allocates" against this track
-- instead of trading directionally — its edge IS the NAV change (fed to the
-- per-lane scorecard via unrealizedPnlUsd). See docs/scout/SCOUT_ALPHA_ROADMAP.md.
--
-- Append-only time series (like market_snapshots): one row per (vault, fetch).

create table if not exists public.vault_snapshots (
  id               uuid primary key default gen_random_uuid(),
  vault_address    text not null,
  name             text,
  kind             text not null default 'hlp' check (kind in ('hlp','operator')),
  nav_usd          double precision,
  apr_annual       double precision,        -- 0.12 = 12%
  max_drawdown_pct double precision,        -- 0..1 peak-to-trough over the observed window
  age_days         double precision,
  leader_fraction  double precision,        -- leader skin-in-the-game (0..1)
  fetched_at       timestamptz not null default now()
);

create index if not exists idx_vault_snapshots_vault_time
  on public.vault_snapshots (vault_address, fetched_at desc);

-- RLS: anon SELECT only; writes go through the service-role daemon (bypasses RLS).
-- NOT added to the realtime publication (hourly cadence, low value; the scout +
-- cockpit read on demand) — consistent with the 0014 egress trim.
alter table public.vault_snapshots enable row level security;
create policy "anon read vault_snapshots" on public.vault_snapshots for select using (true);
