-- HL Cockpit — operator-authored PREVIEW proposals + Claude review.
--
-- Extends pending_actions so the COCKPIT itself (not only a Claude skill) can
-- author a proposed OPEN position in a 'preview' state. Claude READS previews and
-- writes a 'review' annotation; the operator approves a preview from the popup,
-- which executes ROUTE-DRIVEN (no polling skill watches operator rows). NO-AUTO-
-- FIRE is preserved: a preview NEVER executes on creation or on Claude's review —
-- only on the operator's explicit Approve click.
--
--   * status gains:
--       'preview'   — created by the operator, awaiting their decision.
--       'executing' — atomic CLAIM held while the in-route executor runs (the
--                     guard that makes a double-click impossible to double-fire).
--       'executed'  — terminal for operator rows. DISTINCT from the skill path's
--                     'approved' so nothing that scans status='approved' could ever
--                     re-fire an already-executed operator position.
--   * origin ('skill'|'operator', default 'skill') — who authored the row + which
--     execute path applies. Existing rows + skill inserts backfill to 'skill'.
--   * review jsonb (nullable) — Claude's evaluation {verdict, note, reviewedAt}.
--
-- Idempotent / re-runnable (0002 style). RLS UNCHANGED: anon SELECT only; all
-- writes are service-role. New columns ride the existing REPLICA IDENTITY FULL +
-- supabase_realtime publication into the browser, so the popup updates live.

-- 1) Extend the status CHECK. The 0002 constraint is INLINE + UNNAMED, so its name
--    is not guaranteed across environments — discover + drop ANY check that
--    references `status`, then add a NEW explicitly-named constraint (a stable
--    handle for future migrations). A naive DROP CONSTRAINT <guessed-name> would
--    error on re-run / on a differently-named auto-constraint.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.pending_actions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.pending_actions drop constraint %I', c);
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pending_actions'::regclass
      and conname = 'pending_actions_status_check'
  ) then
    alter table public.pending_actions
      add constraint pending_actions_status_check
      check (status in ('pending','preview','executing','approved','rejected','executed','expired'));
  end if;
end$$;

-- 2) origin — NOT NULL with a default so existing rows + every skill insert stay
--    valid without code changes. The inline check auto-names; `add column if not
--    exists` is itself idempotent, so re-running is safe.
alter table public.pending_actions
  add column if not exists origin text not null default 'skill'
  check (origin in ('skill','operator'));

-- 3) review — nullable jsonb. Shape ({verdict,note,reviewedAt}) is enforced in the
--    app/mapper layer, not the DB (keeps the annotation schema flexible).
alter table public.pending_actions
  add column if not exists review jsonb;
