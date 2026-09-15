-- Custom admin roles and permission sets.
create table if not exists public.admin_role_definitions (
  slug text primary key,
  name text not null,
  description text,
  permissions jsonb not null default '[]'::jsonb,
  is_system boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_roles drop constraint if exists admin_roles_role_check;
alter table public.admin_role_definitions enable row level security;

insert into public.admin_role_definitions (slug, name, description, permissions, is_system)
values
  ('owner', 'Owner', 'Full access, including role management and audit controls.', '["events","schedule","eoi","money","scores","roster","media","tournaments","announcements","roles","audit"]'::jsonb, true),
  ('admin', 'Administrator', 'Full club operations access without role management.', '["events","schedule","eoi","money","scores","roster","media","tournaments","announcements","audit"]'::jsonb, true),
  ('treasurer', 'Treasurer', 'Payments, shuttle fees, and payment history.', '["money","audit"]'::jsonb, true),
  ('scheduler', 'Session Coordinator', 'Events, attendance, pairings, and schedules.', '["events","schedule","eoi","audit"]'::jsonb, true),
  ('scorekeeper', 'Scorekeeper', 'Scores, live scoring, and schedules.', '["scores","schedule","audit"]'::jsonb, true),
  ('media', 'Media Manager', 'Club media uploads and media administration.', '["media","audit"]'::jsonb, true)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  permissions = excluded.permissions,
  is_system = true,
  updated_at = now();

create index if not exists admin_role_definitions_active_idx
  on public.admin_role_definitions (active, name);

