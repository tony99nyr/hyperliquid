-- 0043: drafter anchor price on ladders — enables draft re-anchor.
--
-- The runaway/trend drafters derive EVERY rung price as a fixed ratio of the mark
-- at detection time. That mark was never persisted, so when price ran through a
-- gate before the operator could arm (three stale-gate incidents by 2026-10-03),
-- the instant-fire guard correctly refused the arm and the draft was un-armable
-- without a manual DB edit. Storing the anchor lets the re-anchor route scale the
-- whole plan to the live mark (same ratios, same $ risk) as a DRAFT edit.
--
-- NULL = a manually built draft: its levels are structural (supports, bases), not
-- ratios of a mark, so re-anchor REFUSES it by design.
alter table public.ladders add column if not exists anchor_px numeric;

comment on column public.ladders.anchor_px is
  'Drafter detection mark: every rung price is a fixed ratio of it (re-anchor scales by live mark / anchor). NULL = manual draft, structural levels, re-anchor refused.';
