-- Location-specific hourly court rate schedules.

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

alter table public.events
  add column if not exists location_id text,
  add column if not exists court_fee_manual boolean not null default false,
  add column if not exists court_2_fee_manual boolean not null default false,
  add column if not exists court_3_fee_manual boolean not null default false;

insert into public.locations (id, name, suburb, timezone)
values ('sydney-sports-club-kings-park', 'Sydney Sports Club', 'Kings Park', 'Australia/Sydney')
on conflict (id) do update set
  name = excluded.name,
  suburb = excluded.suburb,
  timezone = excluded.timezone;

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
on conflict (location_id, day_type, start_minute) do update set
  end_minute = excluded.end_minute,
  hourly_rate = excluded.hourly_rate;

update public.events
set location_id = 'sydney-sports-club-kings-park'
where location = 'Sydney Sports Club'
  and suburb = 'Kings Park'
  and location_id is null;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where constraint_schema = 'public'
      and table_name = 'events'
      and constraint_name = 'events_location_id_fkey'
  ) then
    alter table public.events
      add constraint events_location_id_fkey
      foreign key (location_id) references public.locations(id);
  end if;
end $$;

alter table public.locations enable row level security;
alter table public.location_court_rates enable row level security;

