# Kingsmen Badminton

Shared social badminton app for Kingsmen Badminton Club. It keeps player EOIs,
events, scores, media, payment tracking, shuttle costs, admin edits, and
player-hour prorating in one Netlify + Supabase app.

Players do not need an account. They choose their name from the roster.

## Database Setup

1. Create a project at https://supabase.com.
2. Open **SQL Editor**.
3. Run `supabase/schema.sql` if this is a new Supabase project.
4. If upgrading an older social app database, run any migrations you have not
   already applied, then run `supabase/migrations/005_kingsmen_badminton.sql`
   and `supabase/migrations/006_badminton_score_format.sql`.

The schema creates the Kingsmen roster:

Pavel, Ashik, Alam, Kibria, Ayon, Rafeed, Palash, Shaikat, Harsha, Rizvi, Saad,
Emon, Shajib, Zahir.

## Deploy To Netlify

1. Upload this folder to a new GitHub repository.
2. In Netlify, choose **Add new project -> Import an existing project**.
3. Select the GitHub repository.
4. Netlify reads `netlify.toml`; no build command is required.

Add these Netlify environment variables for Functions:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase private service-role key |
| `ADMIN_SESSION_SECRET` | Long random secret, at least 32 characters |
| `INITIAL_ADMIN_PASSCODE` | First 4-8 digit admin passcode |

Never expose the service-role key in browser code.

## Rules Implemented

- App name: Kingsmen Badminton.
- Club name: Kingsmen Badminton Club.
- Logo: `public/assets/kingsmen-logo.png`.
- Thursday 9-11 PM sessions are fixed.
- A weekly Monday 9-11 PM session is generated as the default extra session; Admin can edit the date to Tuesday when courts are only available Tuesday.
- New events default to two courts at `$69` each for two hours.
- Admin can edit event date, time, location, court count, court fees, shuttle fees, roster, EOIs, payments, scores, and passcode.
- Play tab defaults to the next upcoming event and also shows the last two completed events.
- Scores tab defaults to the last event that has started.
- Scores can be entered after the event start time by players marked In.
- Badminton scores are played to 21 points, must be won by 2 from 20-all onward, and cap at 30 points.
- Payments tab shows finished sessions only, defaults to the last finished event, and caps the selector to six relevant open or recent events.
- Any player marked In can enter the total shuttle fee after the session finishes.
- Payment cost is `court fees + shuttle fees`.
- Player payment is prorated by hours played. Example: a 1-hour player pays half the cost weight of a 2-hour player.
- Admin can edit each player's hours for each event from Payment Tracking.
- PayID details:
  - Shaz: `0478124622`
  - Ashik: `0416648100`
- Media upload and download remain available for session photos/videos.

## Identity Note

Because players do not sign in, anyone with the public link can choose any
roster name. That keeps the app friction-free, but a future player PIN or email
login would be needed for stronger identity protection.
