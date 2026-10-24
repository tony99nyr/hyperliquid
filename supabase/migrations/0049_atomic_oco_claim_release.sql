-- Lock the OCO row in both claim and release paths. The lock covers the fire insert
-- and the sibling check, so a release cannot race a second open rung's claim.
alter table public.ladder_fires drop constraint if exists ladder_fires_status_check;
alter table public.ladder_fires add constraint ladder_fires_status_check
  check (status in ('claimed', 'filled', 'failed', 'flattened', 'skipped'));

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
  select c.ladder_id into winner_id from public.ladder_oco_claims c
  where c.group_id = v_group_id for update;
  if winner_id is distinct from p_ladder_id then return null; end if;

  insert into public.ladder_fires (ladder_id, rung_id, dedupe_key, status)
  values (p_ladder_id, p_rung_id, p_dedupe_key, 'claimed')
  on conflict do nothing returning id into claimed_id;
  return claimed_id;
end;
$$;

create or replace function public.release_oco_ladder_claim(
  p_group_id uuid, p_ladder_id uuid, p_rung_id uuid
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  -- Only the failed open rung may release its ladder's group claim.
  if not exists (
    select 1 from public.ladders l
    join public.ladder_rungs r on r.ladder_id = l.id
    where l.id = p_ladder_id and l.oco_group_id = p_group_id
      and r.id = p_rung_id and r.action = 'open'
  ) then raise exception 'invalid OCO release rung'; end if;

  select c.ladder_id into v_owner from public.ladder_oco_claims c
  where c.group_id = p_group_id for update;
  if v_owner is distinct from p_ladder_id then return false; end if;

  if exists (
    select 1 from public.ladder_rungs r
    where r.ladder_id = p_ladder_id and r.action = 'open'
      and r.id <> p_rung_id
      and (r.status = 'fired' or exists (
        select 1 from public.ladder_fires f
        where f.rung_id = r.id and f.status in ('claimed', 'filled')
      ))
  ) then return false; end if;

  delete from public.ladder_oco_claims c
  where c.group_id = p_group_id and c.ladder_id = p_ladder_id;
  return true;
end;
$$;

revoke all on function public.claim_oco_ladder_fire(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_oco_ladder_fire(uuid, uuid, text) to service_role;
revoke all on function public.release_oco_ladder_claim(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_oco_ladder_claim(uuid, uuid, uuid) to service_role;
