-- Live doubles scoring, editable pairings, rotating schedule, and optional third court.

alter table public.events
  add column if not exists court_3_enabled boolean not null default false,
  add column if not exists court_3_name text not null default 'Court 3',
  add column if not exists court_3_start_time time not null default '22:00',
  add column if not exists court_3_end_time time not null default '23:00',
  add column if not exists court_3_fee numeric(10,2) not null default 69.00;

alter table public.match_scores
  alter column submitted_by drop not null;

alter table public.match_scores
  add column if not exists match_number integer,
  add column if not exists court_name text,
  add column if not exists scheduled_start time,
  add column if not exists scheduled_end time,
  add column if not exists target_points integer not null default 21,
  add column if not exists best_of integer not null default 1,
  add column if not exists status text not null default 'completed',
  add column if not exists current_game integer not null default 1,
  add column if not exists points_a integer not null default 0,
  add column if not exists points_b integer not null default 0,
  add column if not exists server_team text,
  add column if not exists server_player_id uuid references public.players(id),
  add column if not exists server_position text,
  add column if not exists game_scores jsonb not null default '[]'::jsonb,
  add column if not exists score_history jsonb not null default '[]'::jsonb,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz;

alter table public.match_scores
  drop constraint if exists match_scores_target_points_check,
  drop constraint if exists match_scores_best_of_check,
  drop constraint if exists match_scores_status_check,
  drop constraint if exists match_scores_server_team_check,
  drop constraint if exists match_scores_server_position_check;

alter table public.match_scores
  add constraint match_scores_target_points_check check (target_points in (15, 21, 30)),
  add constraint match_scores_best_of_check check (best_of in (1, 3)),
  add constraint match_scores_status_check check (status in ('scheduled', 'live', 'completed')),
  add constraint match_scores_server_team_check check (server_team in ('A', 'B') or server_team is null),
  add constraint match_scores_server_position_check check (server_position in ('left', 'right') or server_position is null);

update public.match_scores
set status = 'completed',
    target_points = case when target_points not in (15, 21, 30) then 21 else target_points end,
    best_of = case when best_of not in (1, 3) then 1 else best_of end,
    points_a = case when points_a = 0 and games_a between 0 and 30 then games_a else points_a end,
    points_b = case when points_b = 0 and games_b between 0 and 30 then games_b else points_b end
where status is null or target_points not in (15, 21, 30) or best_of not in (1, 3);

create index if not exists match_scores_event_schedule_idx
  on public.match_scores (event_id, scheduled_start, match_number);
