-- Opt-in Web Push subscriptions and daily reminder de-duplication.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.push_notification_log (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  notification_type text not null,
  reminder_date date not null default (now() at time zone 'Australia/Sydney')::date,
  created_at timestamptz not null default now(),
  unique (player_id, event_id, notification_type, reminder_date)
);

alter table public.push_subscriptions enable row level security;
alter table public.push_notification_log enable row level security;

create index if not exists push_subscriptions_player_idx
  on public.push_subscriptions (player_id, last_seen_at desc);

create index if not exists push_notification_log_date_idx
  on public.push_notification_log (reminder_date desc, event_id);
