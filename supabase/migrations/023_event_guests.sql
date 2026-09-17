-- One-session guest players. Guests reuse the existing player references so they
-- work with attendance, pairings, scores, hours, and payments without a PIN.
alter table public.players
  add column if not exists is_guest boolean not null default false,
  add column if not exists guest_event_id uuid references public.events(id) on delete set null;

create index if not exists players_guest_event_idx
  on public.players (guest_event_id, active)
  where is_guest = true;
