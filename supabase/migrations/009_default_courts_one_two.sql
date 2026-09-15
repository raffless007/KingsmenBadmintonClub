-- New default court numbers for all future Kingsmen Badminton sessions.

alter table public.events
  alter column court_1_name set default 'Court 1',
  alter column court_2_name set default 'Court 2';

update public.events
set court_1_name = 'Court 1',
    court_2_name = 'Court 2',
    updated_at = now()
where event_date >= date '2026-09-17';
