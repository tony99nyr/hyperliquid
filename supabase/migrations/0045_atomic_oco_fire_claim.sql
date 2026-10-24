-- Reserve an OCO group for one ladder. Its own later opener rungs remain eligible.
create table if not exists public.ladder_oco_claims (
  group_id uuid primary key,
  ladder_id uuid not null references public.ladders(id),
  claimed_at timestamptz not null default now()
);
alter table public.ladder_oco_claims enable row level security;

-- Existing open fires reserve their groups before the new claim path runs.
insert into public.ladder_oco_claims (group_id, ladder_id)
select distinct on (l.oco_group_id) l.oco_group_id, l.id
from public.ladder_fires f
join public.ladders l on l.id = f.ladder_id
join public.ladder_rungs r on r.id = f.rung_id
where l.oco_group_id is not null and r.action = 'open'
order by l.oco_group_id, f.fired_at, f.id
on conflict do nothing;

create or replace function public.claim_oco_ladder_fire(
  p_ladder_id uuid, p_rung_id uuid, p_dedupe_key text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_group_id uuid;
declare winner_id uuid;
declare claimed_id uuid;
begin
  select l.oco_group_id into v_group_id
  from public.ladders l
  join public.ladder_rungs r on r.ladder_id = l.id
  where l.id = p_ladder_id and r.id = p_rung_id
    and l.status = 'armed' and r.status = 'pending' and r.action = 'open'
    and p_dedupe_key = l.id::text || ':' || r.id::text;
  if v_group_id is null then return null; end if;

  insert into public.ladder_oco_claims (group_id, ladder_id)
  values (v_group_id, p_ladder_id) on conflict do nothing;
  select c.ladder_id into winner_id from public.ladder_oco_claims c where c.group_id = v_group_id;
  if winner_id is distinct from p_ladder_id then return null; end if;

  insert into public.ladder_fires (ladder_id, rung_id, dedupe_key, status)
  values (p_ladder_id, p_rung_id, p_dedupe_key, 'claimed')
  on conflict do nothing returning id into claimed_id;
  return claimed_id;
end;
$$;

revoke all on function public.claim_oco_ladder_fire(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_oco_ladder_fire(uuid, uuid, text) to service_role;
