-- 0037: price_alerts — one-shot operator price pings (NEVER trades).
--
-- A tiny alerting primitive for the desk: "ping Discord when COIN crosses PX".
-- First use: the panel-#4 HYPE base-bid is a sweep-and-reclaim entry whose
-- precondition (price must TAG <=62.60 before the reclaim gate is armable)
-- cannot be mechanized as a ladder rung — the alert tells the operator to arm
-- the drafted ladder. Checked by the production ladder-watch cron each tick;
-- single-fire (status armed -> fired). Informational only: no execution path
-- reads this table.
create table if not exists public.price_alerts (
  id          uuid primary key default gen_random_uuid(),
  coin        text not null,
  direction   text not null check (direction in ('above','below')),
  trigger_px  double precision not null check (trigger_px > 0),
  message     text not null default '',
  status      text not null check (status in ('armed','fired','cancelled')) default 'armed',
  created_at  timestamptz not null default now(),
  fired_at    timestamptz
);

create index if not exists idx_price_alerts_armed on public.price_alerts (status) where status = 'armed';

alter table public.price_alerts enable row level security;
-- Browser (anon) may read (cockpit display); only service-role writes.
drop policy if exists price_alerts_select on public.price_alerts;
create policy price_alerts_select on public.price_alerts for select using (true);
