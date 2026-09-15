-- Thursday EOI locks, late-cancellation court penalties, and protected edits.

alter table public.events
  add column if not exists schedule_generated_at timestamptz;

alter table public.eois
  add column if not exists locked_in boolean not null default false,
  add column if not exists locked_at timestamptz,
  add column if not exists penalty_amount numeric(10,2) not null default 0;

alter table public.match_scores
  add column if not exists pairing_manual boolean not null default false,
  add column if not exists schedule_manual boolean not null default false;

create index if not exists eois_event_status_idx
  on public.eois (event_id, status);
