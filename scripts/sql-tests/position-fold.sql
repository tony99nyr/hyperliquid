-- Contract test for apply_position_fold and list_unfolded_live_positions
-- (migrations 0052 and 0053). scripts/test-fold-sql.sh runs it in a throwaway
-- Postgres after a minimal schema and both migrations. Any failed check raises.
\set ON_ERROR_STOP 1
set role service_role;

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
end $$;

-- The baseline: an old row with no pending fold gets its ledger count; a row with a
-- marked fill or a fill newer than its last write stays at 0 and is listed.
select pg_temp.check((select ledger_fill_count from positions where coin = 'OLD') = 3, 'old row baselined');
select pg_temp.check((select ledger_fill_count from positions where coin = 'MARK') = 0, 'marked row left at 0');
select pg_temp.check((select ledger_fill_count from positions where coin = 'NEW') = 0, 'row with a newer fill left at 0');
select pg_temp.check(
  (select array_agg(coin order by coin) from list_unfolded_live_positions(10)) = array['MARK', 'NEW', 'NOROW'],
  'gap list holds only the pending live rows and a recent fill with no row');

-- The version check: newer applies, stale is refused, equal applies.
insert into fills (session_id, coin) select 'a0000000-0000-0000-0000-000000000000', 'ETH' from generate_series(1, 4);
select pg_temp.check(apply_position_fold('a0000000-0000-0000-0000-000000000000', 'ETH', 'long', 3, 100, 10, 1, '2026-11-20T00:00:00Z', 5, 'carry', 3), 'first fold applies');
select pg_temp.check(apply_position_fold('a0000000-0000-0000-0000-000000000000', 'ETH', 'long', 4, 100, 20, 2, '2026-11-20T00:00:00Z', null, null, 4), 'newer fold applies');
select pg_temp.check(not apply_position_fold('a0000000-0000-0000-0000-000000000000', 'ETH', 'long', 3, 100, 10, 1, '2026-11-20T00:00:00Z', null, null, 3), 'stale fold refused');
select pg_temp.check((select sz = 4 and realized_pnl_usd = 20 and leverage = 5 and lane = 'carry' from positions where coin = 'ETH'), 'stale fold left the newer row, same run kept metadata');
select pg_temp.check((select count(*) = 2 from pnl where coin = 'ETH'), 'pnl snapshot only for applied folds');

-- Metadata: a repeated close keeps it; a reopen with unknown metadata clears it.
select pg_temp.check(apply_position_fold('a0000000-0000-0000-0000-000000000000', 'ETH', 'flat', 0, 0, 30, 2, null, null, null, 4), 'close at an equal count applies');
select pg_temp.check(apply_position_fold('a0000000-0000-0000-0000-000000000000', 'ETH', 'flat', 0, 0, 30, 2, null, null, null, 4), 'repeated close applies');
select pg_temp.check((select side = 'flat' and sz = 0 and leverage = 5 and lane = 'carry' from positions where coin = 'ETH'), 'repeated close is flat and keeps metadata');
insert into fills (session_id, coin) values ('a0000000-0000-0000-0000-000000000000', 'ETH');
select apply_position_fold('a0000000-0000-0000-0000-000000000000', 'ETH', 'long', 1, 100, 30, 2, '2026-11-22T00:00:00Z', null, null, 5);
select pg_temp.check((select leverage is null and lane is null from positions where coin = 'ETH'), 'reopen takes its own (unknown) metadata');

-- A refused opening fold of the same run fills missing metadata.
select pg_temp.check(not apply_position_fold('a0000000-0000-0000-0000-000000000000', 'ETH', 'long', 1, 100, 30, 2, '2026-11-22T00:00:00Z', 3, 'vault', 4), 'older opening fold refused');
select pg_temp.check((select leverage = 3 and lane = 'vault' from positions where coin = 'ETH'), 'refused fold filled the null metadata');

-- A hand-deleted fill heals: the stored count is above the ledger, so a fresh fold applies.
delete from fills where id = (select id from fills where coin = 'ETH' limit 1);
select pg_temp.check(apply_position_fold('a0000000-0000-0000-0000-000000000000', 'ETH', 'long', 1, 100, 30, 2, '2026-11-22T00:00:00Z', null, null, 4), 'count above ledger heals');

reset role;
-- Only service_role may run the functions. Check the grants directly: anon has no
-- table privileges here, so a call would fail on the table even with a leaked grant.
select pg_temp.check(not has_function_privilege(r, f, 'execute'), r || ' cannot execute ' || f)
from unnest(array['anon', 'authenticated', 'public']) as r,
     unnest(array[
       'public.apply_position_fold(uuid, text, text, float8, float8, float8, float8, timestamptz, float8, text, integer)',
       'public.list_unfolded_live_positions(integer)']) as f
where r <> 'public';
select pg_temp.check(has_function_privilege('service_role', 'public.list_unfolded_live_positions(integer)', 'execute'), 'service_role can execute the gap list');
select 'position-fold SQL contract: PASS';
