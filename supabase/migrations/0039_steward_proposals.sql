-- 0039: steward_proposals — the steward's COUNTERFACTUAL track record.
--
-- Operator requirement (Jul-17): overnight proposals go unactioned by design
-- (the human is asleep) — so every proposal must be scoreable later against
-- "if we had executed it, would it have helped?". Each row freezes the market
-- state at proposal time (mark, position side/size, the concrete param) and a
-- deterministic resolver (production ladder-watch tick) scores it at
-- resolution (position flat or the 24h horizon): helped_usd > 0 means acting
-- on the proposal would have beaten what actually happened. This ledger is the
-- ONLY evidence base for ever widening the steward's authority.
create table if not exists public.steward_proposals (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  coin           text not null,
  title          text not null,
  body           text not null default '',
  -- 'exit'/'bank' and 'stop-tighten' are deterministically scorable in v1;
  -- 'disarm'/'widen-target'/'info' are recorded but resolve 'unscorable'.
  proposal_kind  text not null check (proposal_kind in ('exit','bank','stop-tighten','disarm','widen-target','info')),
  -- Frozen at proposal time (null when no live position was referenced):
  side           text check (side in ('long','short')),
  position_sz    double precision,
  mark_px        double precision,
  param_px       double precision,
  ladder_id8     text,
  -- Resolution:
  status         text not null check (status in ('open','resolved','unscorable')) default 'open',
  horizon_at     timestamptz not null,
  resolved_at    timestamptz,
  cf_exit_px     double precision,
  actual_ref_px  double precision,
  helped_usd     double precision,
  resolution_note text
);
create index if not exists idx_steward_proposals_open on public.steward_proposals (status, horizon_at) where status = 'open';
alter table public.steward_proposals enable row level security;
drop policy if exists steward_proposals_select on public.steward_proposals;
create policy steward_proposals_select on public.steward_proposals for select using (true);
