-- One event key owns both unarmed live drafts. The function runs in one transaction.
create table if not exists public.event_straddle_preps (
  event_id text primary key,
  long_ladder_id uuid references public.ladders(id),
  short_ladder_id uuid references public.ladders(id),
  created_at timestamptz not null default now(),
  constraint event_straddle_pair_complete check (
    (long_ladder_id is null and short_ladder_id is null) or
    (long_ladder_id is not null and short_ladder_id is not null)
  )
);
alter table public.event_straddle_preps enable row level security;
revoke all on public.event_straddle_preps from public, anon, authenticated;
grant select, insert, update on public.event_straddle_preps to service_role;

create or replace function public.create_event_straddle_pair(p_event_id text, p_legs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_existing public.event_straddle_preps%rowtype;
  v_leg jsonb;
  v_rung jsonb;
  v_ids uuid[] := array[]::uuid[];
  v_ladder_id uuid;
  v_group_id uuid;
  v_side text;
  v_index integer;
begin
  if p_event_id is null or length(p_event_id) = 0 or length(p_event_id) > 250 or
     jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) <> 2 then
    raise exception 'invalid event straddle input';
  end if;
  -- A conflicting insert waits for the other transaction, then reads its pair.
  insert into public.event_straddle_preps(event_id) values (p_event_id)
  on conflict do nothing;
  select * into v_existing from public.event_straddle_preps
  where event_id = p_event_id for update;
  if v_existing.long_ladder_id is not null and v_existing.short_ladder_id is not null then
    return jsonb_build_object('created', false, 'ids', jsonb_build_array(v_existing.long_ladder_id, v_existing.short_ladder_id));
  end if;
  if v_existing.event_id is null then raise exception 'event prep claim unavailable'; end if;
  v_group_id := (p_legs->0->>'oco_group_id')::uuid;
  if v_group_id is null or v_group_id is distinct from (p_legs->1->>'oco_group_id')::uuid then
    raise exception 'event straddle OCO group mismatch';
  end if;
  for v_index in 0..1 loop
    v_leg := p_legs->v_index;
    v_side := case when v_index = 0 then 'long' else 'short' end;
    if v_leg->>'mode' <> 'live' or v_leg->>'author' <> 'operator' or
       jsonb_typeof(v_leg->'rungs') <> 'array' or jsonb_array_length(v_leg->'rungs') <> 6 or
       v_leg->'rungs'->0->>'side' <> v_side or v_leg->'rungs'->0->>'action' <> 'open' then
      raise exception 'invalid event straddle leg';
    end if;
    insert into public.ladders (
      title, thesis, author, mode, status, oco_group_id, active_from, expires_at,
      max_total_notional_usd, max_total_loss_usd
    ) values (
      v_leg->>'title', v_leg->>'thesis', 'operator', 'live', 'draft', v_group_id,
      (v_leg->>'active_from')::timestamptz, (v_leg->>'expires_at')::timestamptz,
      (v_leg->>'max_total_notional_usd')::numeric, (v_leg->>'max_total_loss_usd')::numeric
    ) returning id into v_ladder_id;
    v_ids := array_append(v_ids, v_ladder_id);
    for v_rung in select value from jsonb_array_elements(v_leg->'rungs') loop
      insert into public.ladder_rungs (
        ladder_id, seq, coin, side, action, trigger_kind, trigger_px, trigger_meta,
        reduce_frac, risk_usd, stop_frac, leverage, status
      ) values (
        v_ladder_id, (v_rung->>'seq')::integer, v_rung->>'coin', v_rung->>'side',
        v_rung->>'action', v_rung->>'trigger_kind', (v_rung->>'trigger_px')::numeric,
        v_rung->'trigger_meta', (v_rung->>'reduce_frac')::numeric,
        (v_rung->>'risk_usd')::numeric, (v_rung->>'stop_frac')::numeric,
        (v_rung->>'leverage')::integer, 'pending'
      );
    end loop;
  end loop;
  update public.event_straddle_preps set long_ladder_id = v_ids[1], short_ladder_id = v_ids[2]
  where event_id = p_event_id;
  return jsonb_build_object('created', true, 'ids', to_jsonb(v_ids));
end;
$$;

revoke all on function public.create_event_straddle_pair(text, jsonb) from public, anon, authenticated;
grant execute on function public.create_event_straddle_pair(text, jsonb) to service_role;
