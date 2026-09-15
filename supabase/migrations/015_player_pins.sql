-- Per-player PINs used by the clubhouse entry prompt.

alter table public.players
  add column if not exists pin_hash text;
