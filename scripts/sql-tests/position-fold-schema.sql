-- The minimal schema that migrations 0052 and 0053 need, plus the rows that the
-- baseline step reads. Not the real schema: only the columns these functions touch.
create role anon; create role authenticated; create role service_role;
create table public.sessions (id uuid primary key, mode text not null default 'paper');
create table public.positions (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.sessions (id),
  coin text not null, side text not null, sz double precision not null default 0,
  avg_entry_px double precision not null default 0, realized_pnl_usd double precision not null default 0,
  fees_paid_usd double precision not null default 0, updated_at timestamptz not null default now(),
  leverage double precision, opened_at timestamptz, lane text, unique (session_id, coin));
create table public.pnl (
  id uuid primary key default gen_random_uuid(), session_id uuid not null, coin text not null,
  realized_pnl_usd double precision not null default 0, unrealized_pnl_usd double precision not null default 0,
  fees_paid_usd double precision not null default 0, mark_px double precision,
  created_at timestamptz not null default now());
create table public.fills (
  id uuid primary key default gen_random_uuid(), session_id uuid not null, coin text not null,
  filled_at timestamptz not null default now(), hl_raw jsonb);
grant all on public.sessions, public.positions, public.pnl, public.fills to service_role;

insert into sessions values ('a0000000-0000-0000-0000-000000000000', 'live'), ('b0000000-0000-0000-0000-000000000000', 'paper');
-- OLD: three old fills, folded since: baselined.
insert into fills (session_id, coin, filled_at) select 'a0000000-0000-0000-0000-000000000000', 'OLD', now() - interval '30 days' from generate_series(1, 3);
insert into positions (session_id, coin, side) values ('a0000000-0000-0000-0000-000000000000', 'OLD', 'flat');
-- MARK: a fill the old backfill marker flags: pending.
insert into fills (session_id, coin, hl_raw) values ('a0000000-0000-0000-0000-000000000000', 'MARK', '{"foldPending": true}');
insert into positions (session_id, coin, side) values ('a0000000-0000-0000-0000-000000000000', 'MARK', 'flat');
-- NEW: a fill newer than the row's last write: pending.
insert into fills (session_id, coin) values ('a0000000-0000-0000-0000-000000000000', 'NEW');
insert into positions (session_id, coin, side, updated_at) values ('a0000000-0000-0000-0000-000000000000', 'NEW', 'flat', now() - interval '1 day');
-- PAPER: a paper fill with no row: never listed by the live gap check.
insert into fills (session_id, coin) values ('b0000000-0000-0000-0000-000000000000', 'PAPER');
