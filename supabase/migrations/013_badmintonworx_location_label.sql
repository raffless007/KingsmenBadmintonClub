-- Add BadmintonWorx - Norwest as the second selectable location.

insert into public.locations (id, name, suburb, timezone)
values ('badmintonworx-norwest', 'BadmintonWorx - Norwest', 'Norwest', 'Australia/Sydney')
on conflict (id) do update set
  name = excluded.name,
  suburb = excluded.suburb,
  timezone = excluded.timezone;

update public.events
set location = 'BadmintonWorx - Norwest',
    suburb = 'Norwest',
    location_id = 'badmintonworx-norwest'
where location_id = 'badmintonworx-norwest'
   or location in ('BadmintonWorx Norwest', 'BadmintonWorx - Norwest');
