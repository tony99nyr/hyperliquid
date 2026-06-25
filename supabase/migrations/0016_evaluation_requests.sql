-- 0016_evaluation_requests — the on-demand trader-vetting queue (PR-3).
--
-- The cockpit enqueues "vet this wallet" requests here; the NAS research-trader
-- worker (scripts/research-trader-worker.ts) claims pending rows, fetches the
-- wallet's HL fills + clearinghouse, computes the copyability fingerprint
-- (trader-fingerprint-business-logic), and writes a `trader_evaluations` row (0015).
-- This keeps the multi-second deep-fill fetch OFF Vercel (review A3) — Vercel only
-- enqueues + reads the persisted evaluation.
--
-- Security (ADR-0002): anon SELECT only (so the UI can show queue state); writes are
-- service-role (the enqueue route + the worker). NOT on the realtime publication.

create table if not exists public.evaluation_requests (
  id            uuid primary key default gen_random_uuid(),
  leader_address text not null,
  status        text not null default 'pending' check (status in ('pending','processing','done','error')),
  requested_at  timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);

-- Worker claim order + a cheap "is there a recent pending for this address?" dedup.
create index if not exists evaluation_requests_pending_idx
  on public.evaluation_requests (status, requested_at);
create index if not exists evaluation_requests_addr_idx
  on public.evaluation_requests (leader_address, requested_at desc);

alter table public.evaluation_requests enable row level security;
drop policy if exists "anon read evaluation_requests" on public.evaluation_requests;
create policy "anon read evaluation_requests" on public.evaluation_requests for select using (true);
