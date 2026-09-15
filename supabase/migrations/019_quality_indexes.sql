-- Cover the new foreign keys used by waitlists, announcements, tournaments,
-- score replay receipts, and reversible audit history.

create index if not exists announcement_reads_player_idx on public.announcement_reads (player_id, read_at desc);
create index if not exists announcements_created_by_idx on public.announcements (created_by, created_at desc);
create index if not exists audit_logs_reverted_by_idx on public.audit_logs (reverted_by, reverted_at desc);
create index if not exists event_waitlist_player_idx on public.event_waitlist (player_id, event_id);
create index if not exists score_action_receipts_score_idx on public.score_action_receipts (score_id, created_at desc);
create index if not exists score_action_receipts_player_idx on public.score_action_receipts (player_id, created_at desc);
create index if not exists tournament_entries_player_idx on public.tournament_entries (player_id, tournament_id);
create index if not exists tournament_entries_partner_idx on public.tournament_entries (partner_player_id, tournament_id);
create index if not exists tournament_matches_winner_idx on public.tournament_matches (winner_entry_id);
