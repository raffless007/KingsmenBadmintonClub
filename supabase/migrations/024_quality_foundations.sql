-- Quality foundations: optimistic concurrency, audit query speed, and live-score safety.
alter table if exists public.events add column if not exists revision bigint not null default 1;
alter table if exists public.eois add column if not exists revision bigint not null default 1;
alter table if exists public.payments add column if not exists revision bigint not null default 1;
alter table if exists public.match_scores add column if not exists revision bigint not null default 1;
alter table if exists public.media_items add column if not exists revision bigint not null default 1;
alter table if exists public.media_items add column if not exists updated_at timestamptz not null default now();
alter table if exists public.tournaments add column if not exists revision bigint not null default 1;

create or replace function public.kbc_bump_revision()
returns trigger
language plpgsql
as $$
begin
  new.revision := coalesce(old.revision, 0) + 1;
  new.updated_at := coalesce(new.updated_at, now());
  return new;
end;
$$;

drop trigger if exists kbc_revision_events on public.events;
create trigger kbc_revision_events before update on public.events for each row execute function public.kbc_bump_revision();
drop trigger if exists kbc_revision_eois on public.eois;
create trigger kbc_revision_eois before update on public.eois for each row execute function public.kbc_bump_revision();
drop trigger if exists kbc_revision_payments on public.payments;
create trigger kbc_revision_payments before update on public.payments for each row execute function public.kbc_bump_revision();
drop trigger if exists kbc_revision_match_scores on public.match_scores;
create trigger kbc_revision_match_scores before update on public.match_scores for each row execute function public.kbc_bump_revision();
drop trigger if exists kbc_revision_media_items on public.media_items;
create trigger kbc_revision_media_items before update on public.media_items for each row execute function public.kbc_bump_revision();
drop trigger if exists kbc_revision_tournaments on public.tournaments;
create trigger kbc_revision_tournaments before update on public.tournaments for each row execute function public.kbc_bump_revision();

create index if not exists audit_logs_created_at_desc_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_actor_id_idx on public.audit_logs (actor_id);
create index if not exists audit_logs_action_idx on public.audit_logs (action);
create index if not exists match_scores_event_status_idx on public.match_scores (event_id, status);

create table if not exists public.push_delivery_log (
  id uuid primary key default gen_random_uuid(),
  player_id uuid references public.players(id) on delete set null,
  announcement_id uuid references public.announcements(id) on delete set null,
  kind text not null default 'announcement',
  succeeded boolean not null default false,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists push_delivery_log_created_at_idx on public.push_delivery_log (created_at desc);
create index if not exists push_delivery_log_player_idx on public.push_delivery_log (player_id, created_at desc);
alter table public.push_delivery_log enable row level security;

revoke all on function public.kbc_bump_revision() from public;
