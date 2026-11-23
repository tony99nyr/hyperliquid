-- Serialise concurrent position folds per (session, coin).
--
-- applyFillToPositionRows reads the fills ledger, folds it in TypeScript and writes the
-- positions row. Two folds can run at the same time (executeIntent and the reconcile
-- cron backfill). Before this migration the later write won, even when it held the
-- older ledger, so the row could miss a fill and its realized P&L.
--
-- The fix is a version check. Each positions row records how many ledger fills its
-- fold saw. The fills ledger is append-only, so a fold that saw more rows is newer,
-- and a fold that saw the same count saw the same rows. apply_position_fold writes
-- the row only when its count is not lower than the stored count. ON CONFLICT takes a
-- row lock, so the check and the write are one atomic step. The pnl snapshot goes in
-- the same transaction, and only when the positions write happened. The function runs
-- as the caller (security invoker): only service_role may execute it.

alter table public.positions
  add column if not exists ledger_fill_count integer not null default 0;

comment on column public.positions.ledger_fill_count is
  'Number of fills ledger rows the last fold saw. apply_position_fold refuses a fold that saw fewer.';

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
    -- A null leverage or lane means "not known by this fold": keep the stored value.
    leverage = coalesce(excluded.leverage, p.leverage),
    lane = coalesce(excluded.lane, p.lane),
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
