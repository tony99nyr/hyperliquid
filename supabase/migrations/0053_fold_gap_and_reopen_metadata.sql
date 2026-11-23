-- Two follow-ups to 0052 (fold serialisation).
--
-- 1. apply_position_fold: a fold that starts a new open run no longer inherits the
--    previous run's leverage and lane.
-- 2. A durable fold-gap check for every writer. A positions row is behind its ledger
--    when the ledger holds more fills than ledger_fill_count, or when recent fills
--    have no row at all. That covers any fold that failed after its fill committed
--    (executeIntent, the backfill, a raced duplicate), with no marker to keep.
--    list_unfolded_live_positions returns those (session, coin) pairs for live
--    sessions; the reconcile cron re-folds them.
--
-- Baseline: rows written before 0052 have ledger_fill_count 0. Set them to the
-- current ledger count, so the gap check never re-folds old rows. A re-fold of an old
-- row could undo a reconcile flatten (a close the ledger never booked) and bring
-- back a closed position.
update public.positions p
  set ledger_fill_count = (
    select count(*) from public.fills f where f.session_id = p.session_id and f.coin = p.coin
  )
  where p.ledger_fill_count = 0
    -- Leave a row at 0 when a fold is pending, so the gap check re-folds it: a fill
    -- that the old backfill marker still flags, or a fill newer than the row's last
    -- write (a fold stamps updated_at after its fill, so its fold did not run; an
    -- executeIntent fill has no marker). Reconcile does not change updated_at, so a
    -- row that reconcile corrected keeps its baseline.
    and not exists (
      select 1 from public.fills f
      where f.session_id = p.session_id and f.coin = p.coin
        and (f.hl_raw @> '{"foldPending": true}' or f.filled_at > p.updated_at)
    );

create or replace function public.apply_position_fold(
  p_session_id uuid,
  p_coin text,
  p_side text,
  p_sz double precision,
  p_avg_entry_px double precision,
  p_realized_pnl_usd double precision,
  p_fees_paid_usd double precision,
  p_opened_at timestamptz,
  p_leverage double precision,
  p_lane text,
  p_ledger_fill_count integer
) returns boolean language plpgsql security invoker set search_path = public as $$
declare v_applied boolean;
begin
  insert into public.positions as p (
    session_id, coin, side, sz, avg_entry_px, realized_pnl_usd, fees_paid_usd,
    updated_at, opened_at, leverage, lane, ledger_fill_count
  ) values (
    p_session_id, p_coin, p_side, p_sz, p_avg_entry_px, p_realized_pnl_usd, p_fees_paid_usd,
    clock_timestamp(), p_opened_at, p_leverage, p_lane, p_ledger_fill_count
  )
  on conflict (session_id, coin) do update set
    side = excluded.side,
    sz = excluded.sz,
    avg_entry_px = excluded.avg_entry_px,
    realized_pnl_usd = excluded.realized_pnl_usd,
    fees_paid_usd = excluded.fees_paid_usd,
    updated_at = excluded.updated_at,
    opened_at = excluded.opened_at,
    -- A fold that starts a new open run (the row was flat, or the run starts later)
    -- takes its own leverage and lane, null included: the last run's values do not
    -- belong to it. A flat fold never starts a run, so a repeated close keeps them.
    -- Within the same run a null means "not known by this fold", so keep the stored
    -- value. An older backfilled fill moves the start EARLIER and keeps the metadata.
    leverage = case
      when excluded.opened_at is not null and (p.opened_at is null or excluded.opened_at > p.opened_at)
      then excluded.leverage else coalesce(excluded.leverage, p.leverage) end,
    lane = case
      when excluded.opened_at is not null and (p.opened_at is null or excluded.opened_at > p.opened_at)
      then excluded.lane else coalesce(excluded.lane, p.lane) end,
    ledger_fill_count = excluded.ledger_fill_count
  -- The second test heals a stored count above the real ledger (a fill deleted by
  -- hand): without it every later fold would be refused and the row would freeze.
  where p.ledger_fill_count <= excluded.ledger_fill_count
     or p.ledger_fill_count > (
       select count(*) from public.fills f where f.session_id = p_session_id and f.coin = p_coin
     )
  returning true into v_applied;

  if v_applied is null then
    -- Refused: a newer fold already wrote the row. Still fill leverage and lane when
    -- the row has none, so an opening fold that lost the race keeps its metadata. Only
    -- for the same open run (same opened_at): never stamp it on a later reopen.
    update public.positions
      set leverage = coalesce(leverage, p_leverage), lane = coalesce(lane, p_lane)
      where session_id = p_session_id and coin = p_coin
        and opened_at is not distinct from p_opened_at
        and ((leverage is null and p_leverage is not null) or (lane is null and p_lane is not null));
    return false;
  end if;

  -- clock_timestamp, not now(): now() is the transaction start, so a fold that waited
  -- on the row lock would sort before the snapshot it follows.
  insert into public.pnl (session_id, coin, realized_pnl_usd, unrealized_pnl_usd, fees_paid_usd, mark_px, created_at)
  values (p_session_id, p_coin, p_realized_pnl_usd, 0, p_fees_paid_usd, null, clock_timestamp());
  return true;
end;
$$;

revoke all on function public.apply_position_fold(
  uuid, text, text, double precision, double precision, double precision, double precision,
  timestamptz, double precision, text, integer
) from public, anon, authenticated;
grant execute on function public.apply_position_fold(
  uuid, text, text, double precision, double precision, double precision, double precision,
  timestamptz, double precision, text, integer
) to service_role;

create or replace function public.list_unfolded_live_positions(p_limit integer)
returns table (session_id uuid, coin text)
language sql stable security invoker set search_path = public as $$
  select f.session_id, f.coin
  from public.fills f
  join public.sessions s on s.id = f.session_id and s.mode = 'live'
  left join public.positions p on p.session_id = f.session_id and p.coin = f.coin
  group by f.session_id, f.coin, p.id, p.ledger_fill_count
  -- No row: only recent fills, so a session that predates the positions table is
  -- left alone.
  having (p.id is null and max(f.filled_at) > now() - interval '7 days')
      or count(*) > p.ledger_fill_count
  order by f.session_id, f.coin
  limit p_limit;
$$;

revoke all on function public.list_unfolded_live_positions(integer) from public, anon, authenticated;
grant execute on function public.list_unfolded_live_positions(integer) to service_role;
