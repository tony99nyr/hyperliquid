-- Persist operator-confirmed performance markers and monthly forecast snapshots.
create table if not exists public.change_markers (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null,
  kind text not null check (kind in ('process','system','config','lane-registered','lane-killed','sizing')),
  lanes text[] not null default '{}',
  title text not null,
  note text not null default '',
  source text not null check (source in ('commit','manifest','prereg','flag','manual')),
  ref text,
  proposed_by text not null,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_change_markers_at on public.change_markers (at desc);

create table if not exists public.forecast_snapshots (
  id uuid primary key default gen_random_uuid(),
  made_at timestamptz not null default now(),
  horizon_end date not null,
  scope text not null,
  inputs_hash text not null,
  p5 numeric not null,
  p25 numeric not null,
  p50 numeric not null,
  p75 numeric not null,
  p95 numeric not null,
  expected_monthly numeric not null,
  p_positive numeric not null,
  method jsonb not null,
  actual numeric,
  scored_at timestamptz,
  constraint forecast_snapshots_scope_check
    check (scope in ('live','scout') or length(scope) > 0)
);

alter table public.change_markers enable row level security;
alter table public.forecast_snapshots enable row level security;

drop policy if exists "anon read change_markers" on public.change_markers;
create policy "anon read change_markers" on public.change_markers for select to anon using (true);
drop policy if exists "anon read forecast_snapshots" on public.forecast_snapshots;
create policy "anon read forecast_snapshots" on public.forecast_snapshots for select to anon using (true);

revoke all on public.change_markers from anon, authenticated;
revoke all on public.forecast_snapshots from anon, authenticated;
grant select on public.change_markers to anon;
grant select on public.forecast_snapshots to anon;
