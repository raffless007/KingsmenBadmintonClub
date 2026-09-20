# Kingsmen Badminton

Shared social badminton app for Kingsmen Badminton Club. It keeps player EOIs,
events, scores, media, payment tracking, shuttle costs, admin edits, and
player-hour prorating in one Netlify + Supabase app.

Players sign in with a 4 or 6 digit PIN. Admin roles can be activated from the
same player session when that player has an assigned role.

## Database Setup

1. Create a project at https://supabase.com.
2. Open **SQL Editor**.
3. Run `supabase/schema.sql` if this is a new Supabase project.
4. If upgrading an older social app database, run any migrations you have not
   already applied, then run `supabase/migrations/005_kingsmen_badminton.sql`
   and `supabase/migrations/006_badminton_score_format.sql`.
5. Run every migration in `supabase/migrations/` that is newer than the last
   migration already applied to your project. The current quality-foundation
   migration is `024_quality_foundations.sql`; it adds optimistic-concurrency
   revisions, indexes, and live-score conflict protection.

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
| `VAPID_PUBLIC_KEY` | Public key generated for free browser Web Push |
| `VAPID_PRIVATE_KEY` | Private VAPID key; keep it only in Netlify environment variables |
| `VAPID_SUBJECT` | `https://kingsmenclub.netlify.app` |

Never expose the service-role key in browser code.

## Free Phone Notifications

Browser Web Push is used for opt-in pending-payment reminders. It does not use
a paid notification provider. Generate a VAPID key pair with
`npx web-push generate-vapid-keys`, add the public and private keys plus the
subject above to Netlify, then redeploy. After signing in as a player, use
**Enable notifications** under **Who's playing**. On iPhone/iPad, first add the
site to the Home Screen; Web Push is supported for Home Screen web apps on
iOS/iPadOS 16.4 and later.

The scheduled Netlify Function runs the daily pending-payment reminder. It is
available on Netlify's free plan, subject to the account's normal function
limits.

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
- Scores support instant live point entry with prominent undo, server/side display,
  hidden per-match settings for 15/21/30 points, and 1-game or best-of-3 formats.
- Admins can generate and edit a balanced doubles rotation with 12-minute matches
  and a 1-minute changeover. A third court defaults to 10:00 PM and can be edited.
- Payments tab shows finished sessions only, defaults to the last finished event, and caps the selector to six relevant open or recent events.
- Any player marked In can enter the total shuttle fee after the session finishes.
- Payment cost is `court fees + shuttle fees`.
- Player payment is prorated by hours played. Example: a 1-hour player pays half the cost weight of a 2-hour player.
- Admin can edit each player's hours for each event from Payment Tracking.
- PayID details:
  - Shaz: `0478124622`
  - Ashik: `0416648100`
- Media upload and download remain available for session photos/videos.

## Operations checklist

- Check `/.netlify/functions/api?action=health` after every deployment.
- Confirm the returned `appVersion` matches the Git commit deployed to Netlify.
- Run pending Supabase migrations before enabling a new release.
- Export club data periodically from the Admin area before large changes.
- Never expose the Supabase service-role key in the browser or commit production
  environment variables to the repository.
