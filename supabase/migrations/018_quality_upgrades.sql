-- Quality upgrades: waitlists, preferences, roles, announcements, tournaments,
-- idempotent live-score actions, and reversible audit history.

create table if not exists public.event_waitlist (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  position integer not null check (position > 0),
  status text not null default 'pending' check (status in ('pending', 'promoted', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  promoted_at timestamptz,
  unique (event_id, player_id)
);

create table if not exists public.player_notification_preferences (
  player_id uuid primary key references public.players(id) on delete cascade,
  eoi_reminders boolean not null default true,
  schedule_changes boolean not null default true,
  payment_reminders boolean not null default true,
  announcements boolean not null default true,
  tournament_updates boolean not null default true,
  quiet_hours_start time,
  quiet_hours_end time,
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_roles (
  player_id uuid primary key references public.players(id) on delete cascade,
  role text not null default 'admin' check (role in ('owner', 'admin', 'treasurer', 'scheduler', 'scorekeeper', 'media')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  kind text not null default 'announcement' check (kind in ('announcement', 'message', 'alert')),
  pinned boolean not null default false,
  created_by uuid references public.players(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.announcement_reads (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (announcement_id, player_id)
);

create table if not exists public.tournament_entries (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  partner_player_id uuid references public.players(id) on delete set null,
  status text not null default 'registered' check (status in ('registered', 'waitlisted', 'withdrawn')),
  seed integer,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid', 'waived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, player_id)
);

create table if not exists public.tournament_matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  round integer not null default 1,
  match_number integer not null,
  court_name text,
  scheduled_start time,
  scheduled_end time,
  team_a_entry_ids jsonb not null default '[]'::jsonb,
  team_b_entry_ids jsonb not null default '[]'::jsonb,
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'completed', 'cancelled')),
  target_points integer not null default 21 check (target_points between 1 and 30),
  best_of integer not null default 1 check (best_of in (1, 3)),
  games_a integer not null default 0,
  games_b integer not null default 0,
  game_scores jsonb not null default '[]'::jsonb,
  winner_entry_id uuid references public.tournament_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, match_number)
);

create table if not exists public.score_action_receipts (
  client_action_id text primary key,
  score_id uuid not null references public.match_scores(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);

alter table public.audit_logs
  add column if not exists before_data jsonb,
  add column if not exists after_data jsonb,
  add column if not exists reverted_at timestamptz,
  add column if not exists reverted_by uuid references public.players(id) on delete set null;

alter table public.match_scores
  add column if not exists version integer not null default 0;

alter table public.event_waitlist enable row level security;
alter table public.player_notification_preferences enable row level security;
alter table public.admin_roles enable row level security;
alter table public.announcements enable row level security;
alter table public.announcement_reads enable row level security;
alter table public.tournament_entries enable row level security;
alter table public.tournament_matches enable row level security;
alter table public.score_action_receipts enable row level security;

create index if not exists event_waitlist_event_idx on public.event_waitlist (event_id, status, position);
create index if not exists announcements_feed_idx on public.announcements (archived_at, pinned desc, created_at desc);
create index if not exists tournament_entries_tournament_idx on public.tournament_entries (tournament_id, status, created_at);
create index if not exists tournament_matches_tournament_idx on public.tournament_matches (tournament_id, round, match_number);
create index if not exists audit_logs_target_idx on public.audit_logs (target_type, target_id, created_at desc);

-- Scores are non-sensitive and may be observed by the live scoreboard. Writes stay
-- behind the Netlify function using the Supabase service role.
grant select on public.match_scores to anon, authenticated;
drop policy if exists match_scores_public_read on public.match_scores;
create policy match_scores_public_read on public.match_scores
  for select to anon, authenticated using (true);

do $$
begin
  alter publication supabase_realtime add table public.match_scores;
exception when duplicate_object then null;
end $$;
