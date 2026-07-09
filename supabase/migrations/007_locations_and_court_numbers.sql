-- Kingsmen Badminton location and court-number defaults.

alter table public.events
  add column if not exists court_1_name text not null default 'Court 6';

alter table public.events
  alter column location set default 'Sydney Sports Club',
  alter column suburb set default 'Kings Park',
  alter column court_1_name set default 'Court 6',
  alter column court_2_name set default 'Court 5';

update public.events
set
  location = case
    when extract(dow from event_date) = 4 and location in ('Kingsmen Badminton Courts', 'Sydney Sports Club') then 'Sydney Sports Club'
    when extract(dow from event_date) in (1, 2) and location in ('Kingsmen Badminton Courts', 'Sydney Sports Club') then 'BadmintonWorx Norwest'
    else location
  end,
  suburb = case
    when extract(dow from event_date) = 4 and suburb in ('Sydney', 'Kings Park') then 'Kings Park'
    when extract(dow from event_date) in (1, 2) and suburb in ('Sydney', 'Kings Park') then 'Subject to availability'
    else suburb
  end,
  court_1_name = case
    when extract(dow from event_date) = 4 and court_1_name in ('Court 1', 'Court 6') then 'Court 6'
    when extract(dow from event_date) in (1, 2) and court_1_name in ('Court 1', 'Court 6') then 'Court 1'
    else court_1_name
  end,
  court_2_name = case
    when extract(dow from event_date) = 4 and court_2_name in ('Court 2', 'Court 5') then 'Court 5'
    else court_2_name
  end,
  updated_at = now()
where event_date >= current_date;
