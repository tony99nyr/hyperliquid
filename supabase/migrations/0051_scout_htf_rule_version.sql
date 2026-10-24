-- Distinguish the model-driven HTF sample from daemon-owned frozen-rule entries.
alter table public.hypotheses add column if not exists rule_version text;
comment on column public.hypotheses.rule_version is
  'Null for legacy/model-driven samples; htf-trend-donchian-20-10-daemon-v1 for deterministic daemon entries.';
