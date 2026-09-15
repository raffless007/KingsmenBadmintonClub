-- Normalize location records used by the event editor.

insert into public.locations (id, name, suburb, timezone)
values
  ('sydney-sports-club-kings-park', 'Sydney Sports Park - Kings Park', 'Kings Park', 'Australia/Sydney'),
  ('badmintonworx-norwest', 'BadmintonWorx Norwest', 'Subject to availability', 'Australia/Sydney')
on conflict (id) do update set
  name = excluded.name,
  suburb = excluded.suburb,
  timezone = excluded.timezone;

update public.events
set location = 'Sydney Sports Park - Kings Park',
    suburb = 'Kings Park',
    location_id = 'sydney-sports-club-kings-park'
where location_id = 'sydney-sports-club-kings-park'
   or (location = 'Sydney Sports Club' and suburb = 'Kings Park');

update public.events
set location_id = 'badmintonworx-norwest'
where location = 'BadmintonWorx Norwest'
  and location_id is null;
