-- Kingsmen Badminton app updates.

alter table public.events
  alter column start_time set default '21:00',
  alter column end_time set default '23:00',
  alter column location set default 'Kingsmen Badminton Courts',
  alter column suburb set default 'Sydney',
  alter column court_fee set default 69.00,
  alter column court_2_enabled set default true,
  alter column court_2_start_time set default '21:00',
  alter column court_2_end_time set default '23:00',
  alter column court_2_fee set default 69.00;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'events' and column_name = 'ball_fee'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'events' and column_name = 'shuttle_fee'
  ) then
    alter table public.events rename column ball_fee to shuttle_fee;
  elsif not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'events' and column_name = 'shuttle_fee'
  ) then
    alter table public.events add column shuttle_fee numeric(10,2) not null default 0.00;
  end if;
end $$;

alter table public.events
  alter column shuttle_fee set default 0.00;

create table if not exists public.event_player_hours (
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  hours_played numeric(4,2) not null default 2.00 check (hours_played > 0 and hours_played <= 8),
  updated_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

alter table public.event_player_hours enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kingsmen-media', 'kingsmen-media', true, 209715200, array['image/*','video/*'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

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
on conflict (name) do update set active = true;
