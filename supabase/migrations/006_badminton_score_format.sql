-- Update score constraints for badminton points.

alter table public.match_scores
  drop constraint if exists match_scores_games_a_check,
  drop constraint if exists match_scores_games_b_check;

alter table public.match_scores
  add constraint match_scores_games_a_check check (games_a between 0 and 30),
  add constraint match_scores_games_b_check check (games_b between 0 and 30);
