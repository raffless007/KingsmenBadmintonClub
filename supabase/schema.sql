-- Kingsmen Badminton — Supabase database
-- Run this entire file once in Supabase → SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null unique,
  start_time time not null default '21:00',
  end_time time not null default '23:00',
  timezone text not null default 'Australia/Sydney',
  location text not null default 'Sydney Sports Park - Kings Park',
  suburb text not null default 'Kings Park',
  location_id text,
  court_1_name text not null default 'Court 1',
  court_fee numeric(10,2) not null default 69.00,
  court_fee_manual boolean not null default false,
  court_2_enabled boolean not null default true,
  court_2_name text not null default 'Court 2',
  court_2_start_time time not null default '21:00',
  court_2_end_time time not null default '23:00',
  court_2_fee numeric(10,2) not null default 69.00,
  court_2_fee_manual boolean not null default false,
  court_3_enabled boolean not null default false,
  court_3_name text not null default 'Court 3',
  court_3_start_time time not null default '22:00',
  court_3_end_time time not null default '23:00',
  court_3_fee numeric(10,2) not null default 69.00,
  court_3_fee_manual boolean not null default false,
  shuttle_fee numeric(10,2) not null default 0.00,
  account_closed boolean not null default false,
  schedule_generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.locations (
  id text primary key,
  name text not null,
  suburb text not null,
  timezone text not null default 'Australia/Sydney',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.location_court_rates (
  location_id text not null references public.locations(id) on delete cascade,
  day_type text not null check (day_type in ('weekday', 'weekend')),
  start_minute smallint not null check (start_minute between 0 and 1439),
  end_minute smallint not null check (end_minute between 1 and 1440),
  hourly_rate numeric(10,2) not null check (hourly_rate >= 0),
  primary key (location_id, day_type, start_minute),
  check (end_minute > start_minute)
);

create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'registration_open', 'registration_closed', 'in_progress', 'completed', 'cancelled')),
  tournament_type text not null default 'Club tournament',
  discipline text not null default 'Doubles' check (discipline in ('Singles', 'Doubles', 'Mixed doubles', 'Singles and doubles')),
  competition_format text not null default 'Round robin' check (competition_format in ('Round robin', 'Knockout', 'Groups and knockout', 'Swiss system')),
  tournament_date date not null,
  start_time time,
  end_time time,
  timezone text not null default 'Australia/Sydney',
  location_id text references public.locations(id),
  location text not null,
  suburb text,
  registration_open_at timestamptz,
  registration_close_at timestamptz,
  payment_due_at timestamptz,
  max_entries integer check (max_entries is null or max_entries > 0),
  court_count smallint not null default 2 check (court_count > 0),
  match_minutes smallint not null default 12 check (match_minutes > 0),
  changeover_minutes smallint not null default 1 check (changeover_minutes >= 0),
  point_cap smallint not null default 21 check (point_cap between 1 and 30),
  point_differential smallint not null default 2 check (point_differential >= 0),
  best_of smallint not null default 1 check (best_of in (1, 3)),
  entry_fee numeric(10,2) not null default 0 check (entry_fee >= 0),
  shuttle_fee_included boolean not null default false,
  organiser_name text,
  organiser_contact text,
  prize_details text,
  rules text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tournaments enable row level security;

create table if not exists public.eois (
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  status text not null check (status in ('yes','no')),
  locked_in boolean not null default false,
  locked_at timestamptz,
  penalty_amount numeric(10,2) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

create table if not exists public.payments (
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  amount numeric(10,2) not null,
  paid boolean not null default false,
  paid_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

create table if not exists public.event_player_hours (
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  hours_played numeric(4,2) not null default 2.00 check (hours_played > 0 and hours_played <= 8),
  updated_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

create table if not exists public.match_scores (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  team_a_player_ids uuid[] not null,
  team_b_player_ids uuid[] not null,
  games_a integer not null check (games_a between 0 and 30),
  games_b integer not null check (games_b between 0 and 30),
  tiebreak_a integer,
  tiebreak_b integer,
  match_number integer,
  court_name text,
  scheduled_start time,
  scheduled_end time,
  target_points integer not null default 21 check (target_points in (15, 21, 30)),
  best_of integer not null default 1 check (best_of in (1, 3)),
  status text not null default 'completed' check (status in ('scheduled', 'live', 'completed')),
  current_game integer not null default 1,
  points_a integer not null default 0 check (points_a between 0 and 30),
  points_b integer not null default 0 check (points_b between 0 and 30),
  server_team text check (server_team in ('A', 'B')),
  server_player_id uuid references public.players(id),
  server_position text check (server_position in ('left', 'right')),
  game_scores jsonb not null default '[]'::jsonb,
  score_history jsonb not null default '[]'::jsonb,
  pairing_manual boolean not null default false,
  schedule_manual boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  submitted_by uuid references public.players(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(team_a_player_ids) = 2),
  check (cardinality(team_b_player_ids) = 2)
);

create table if not exists public.media_items (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id),
  title text not null,
  media_type text not null check (media_type in ('image','video')),
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null,
  captured_at date not null default (now() at time zone 'Australia/Sydney')::date,
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

create table if not exists public.reminder_log (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  reminder_type text not null,
  sent_at timestamptz not null default now()
);

-- The browser never connects directly to these tables. Only Netlify Functions
-- use the server-side service-role key, so exposed-table access stays closed.
alter table public.players enable row level security;
alter table public.events enable row level security;
alter table public.eois enable row level security;
alter table public.payments enable row level security;
alter table public.event_player_hours enable row level security;
alter table public.match_scores enable row level security;
alter table public.media_items enable row level security;
alter table public.app_settings enable row level security;
alter table public.reminder_log enable row level security;
alter table public.locations enable row level security;
alter table public.location_court_rates enable row level security;

create index if not exists match_scores_event_created_idx
  on public.match_scores (event_id, created_at);

create index if not exists eois_event_status_idx
  on public.eois (event_id, status);

create index if not exists media_items_captured_created_idx
  on public.media_items (captured_at desc, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kingsmen-media', 'kingsmen-media', true, 209715200, array['image/*','video/*'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create unique index if not exists reminder_log_event_player_type_unique
  on public.reminder_log (event_id, player_id, reminder_type)
  where player_id is not null
    and reminder_type in ('session_end_player', '48_hour_unpaid');

create unique index if not exists reminder_log_event_type_owner_unique
  on public.reminder_log (event_id, reminder_type)
  where player_id is null
    and reminder_type = '72_hour_owner';

insert into public.players (name) values
  ('Pavel'),
  ('Ashik'),
  ('Alam'),
  ('Kibria'),
  ('Ayon'),
  ('Rafeed'),
  ('Palash'),
  ('Shaikat'),
  ('Harsha'),
  ('Rizvi'),
  ('Saad'),
  ('Emon'),
  ('Shajib'),
  ('Zahir')
on conflict (name) do nothing;

insert into public.app_settings (key, value)
values ('admin_passcode_hash', null)
on conflict (key) do nothing;

insert into public.locations (id, name, suburb, timezone)
values
  ('sydney-sports-club-kings-park', 'Sydney Sports Park - Kings Park', 'Kings Park', 'Australia/Sydney'),
  ('badmintonworx-norwest', 'BadmintonWorx - Norwest', 'Norwest', 'Australia/Sydney')
on conflict (id) do nothing;

insert into public.location_court_rates (location_id, day_type, start_minute, end_minute, hourly_rate)
values
  ('sydney-sports-club-kings-park', 'weekday', 300, 960, 23.00),
  ('sydney-sports-club-kings-park', 'weekday', 960, 1080, 32.00),
  ('sydney-sports-club-kings-park', 'weekday', 1080, 1320, 41.00),
  ('sydney-sports-club-kings-park', 'weekday', 1320, 1440, 28.00),
  ('sydney-sports-club-kings-park', 'weekend', 300, 420, 30.00),
  ('sydney-sports-club-kings-park', 'weekend', 420, 720, 41.00),
  ('sydney-sports-club-kings-park', 'weekend', 720, 1260, 32.00),
  ('sydney-sports-club-kings-park', 'weekend', 1260, 1320, 30.00),
  ('sydney-sports-club-kings-park', 'weekend', 1320, 1440, 26.00)
on conflict (location_id, day_type, start_minute) do nothing;
