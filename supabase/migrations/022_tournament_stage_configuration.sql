-- Flexible tournament stages, scoring rules, and bracket flow metadata.
alter table public.tournaments
  add column if not exists stage_config jsonb not null default '[]'::jsonb;

alter table public.tournament_matches
  add column if not exists stage_key text,
  add column if not exists stage_name text,
  add column if not exists stage_type text,
  add column if not exists stage_tier text,
  add column if not exists stage_match_number integer,
  add column if not exists group_number integer,
  add column if not exists point_differential smallint not null default 2,
  add column if not exists source_a text,
  add column if not exists source_b text,
  add column if not exists next_stage_key text,
  add column if not exists next_match_number integer;

create index if not exists tournament_matches_stage_idx
  on public.tournament_matches (tournament_id, stage_key, match_number);
