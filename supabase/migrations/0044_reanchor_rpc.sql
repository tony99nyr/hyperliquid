-- 0044: single-transaction draft re-anchor (review 2026-10-04, High #2).
--
-- applyDraftReanchor used to write the ladders row and then each ladder_rungs row
-- as separate PostgREST calls. A failure mid-loop left SOME rungs scaled under a
-- thesis claiming all levels were scaled, and a retry (new anchor ≈ mark) could
-- never heal the unscaled rungs — silent draft corruption. This function does the
-- whole edit in one transaction with the ladders row locked FOR UPDATE, so the
-- result is all-or-nothing and nothing can interleave mid-write.
--
-- DRAFT-ONLY by construction: the status check runs under the row lock. It can
-- never touch an armed ladder's prices. Rung updates re-guard on ladder_id +
-- status='pending'. Patches are computed server-side by the route (the client
-- supplies only a ladderId); this function trusts its caller to the same degree
-- the previous service-role table writes did.
create or replace function public.reanchor_draft_ladder(
  p_ladder_id uuid,
  p_new_anchor numeric,
  p_thesis text,
  p_patches jsonb
) returns text
language plpgsql
as $$
declare
  v_status text;
  p jsonb;
begin
  select status into v_status from public.ladders where id = p_ladder_id for update;
  if v_status is null then
    return 'not-found';
  end if;
  if v_status <> 'draft' then
    return 'not-draft';
  end if;

  update public.ladders
     set anchor_px = p_new_anchor,
         thesis = p_thesis,
         updated_at = now()
   where id = p_ladder_id;

  for p in select * from jsonb_array_elements(p_patches) loop
    update public.ladder_rungs
       set trigger_px = (p->>'triggerPx')::numeric,
           stop_px = (p->>'stopPx')::numeric,
           target_px = (p->>'targetPx')::numeric,
           trigger_meta = case when p ? 'triggerMeta' then nullif(p->'triggerMeta', 'null'::jsonb) else trigger_meta end
     where id = (p->>'rungId')::uuid
       and ladder_id = p_ladder_id
       and status = 'pending';
  end loop;

  return 'applied';
end;
$$;

comment on function public.reanchor_draft_ladder is
  'Atomic draft re-anchor: ladders row (anchor/thesis) + rung price patches in ONE transaction under a row lock. Returns applied | not-draft | not-found. Draft-only; never touches armed prices.';

-- Defence in depth: only the service role may call this. (RLS already reduces an anon
-- call to a no-op 'not-found' — select-only policies filter the FOR UPDATE to zero
-- rows — but a write-shaped RPC should not be callable from PostgREST's anon surface.)
-- NOTE: revoking from PUBLIC strips the default grant from EVERY non-owner role,
-- service_role included — the explicit grant-back is load-bearing, not belt-and-braces.
revoke execute on function public.reanchor_draft_ladder(uuid, numeric, text, jsonb) from public, anon, authenticated;
grant execute on function public.reanchor_draft_ladder(uuid, numeric, text, jsonb) to service_role;
