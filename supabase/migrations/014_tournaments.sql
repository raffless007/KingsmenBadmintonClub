-- Tournament foundation for registrations, draws, scheduling, scoring, and payments.

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
