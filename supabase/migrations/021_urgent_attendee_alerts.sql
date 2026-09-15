-- Allow urgent alerts to target the confirmed attendees of one session.
alter table public.announcements
  add column if not exists urgent boolean not null default false,
  add column if not exists audience text not null default 'all',
  add column if not exists event_id uuid references public.events(id) on delete set null;

alter table public.announcements
  drop constraint if exists announcements_audience_check;

alter table public.announcements
  add constraint announcements_audience_check check (audience in ('all', 'attendees'));

create index if not exists announcements_event_audience_idx
  on public.announcements (event_id, audience, created_at desc);
