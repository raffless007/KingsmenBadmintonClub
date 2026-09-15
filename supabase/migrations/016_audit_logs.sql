-- Admin-only activity history for player, admin, and anonymous actions.

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('admin', 'player', 'anonymous')),
  actor_id uuid references public.players(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  status_code smallint,
  succeeded boolean not null default true,
  details jsonb not null default '{}'::jsonb
);

alter table public.audit_logs enable row level security;

create index if not exists audit_logs_created_idx
  on public.audit_logs (created_at desc);

create index if not exists audit_logs_actor_idx
  on public.audit_logs (actor_id, created_at desc);
