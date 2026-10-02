# cortero-myday — MyDay v2

The family app, rebuilt as a real web app: **React + TypeScript (web/)**, **Node + Express + TypeScript (api/)**, **PostgreSQL**, with request/response types in **shared/** used by both sides.

The Google Apps Script prototype stays live and untouched. This repo serves **staging.conquermyday.app** only.

## Layout

| Path | What |
| --- | --- |
| `shared/` | Every API type. Never duplicate one in api/ or web/. |
| `api/` | The only server. Serves `/api/*` and the built web app. |
| `api/migrations/` | Plain SQL, applied in order on every container start. |
| `web/` | The only client. One folder + route per module in `web/src/modules/`. |
| `deploy/` | One-time droplet bootstrap + the Caddy block. |

## Local development

```bash
npm install
cp api/.env.example api/.env      # point DATABASE_URL at a local Postgres 16
npm run build                     # shared -> api -> web, sequentially
npm run migrate
npm run dev -w api                # :4000, also serves web/dist
npm run dev -w web                # :5173 with /api proxied (optional)
npm run typecheck                 # gate: shared + api + web
```

## Roster + content import (one time)

Identity and data come from the database, and no names are hard-coded. Export each sheet tab from Kester Family HQ as CSV, then run the commands on the droplet (`docker exec -it myday-api node dist/cli.js …`):

```bash
node dist/cli.js member:add --name Ty --kind adult --email you@gmail.com
node dist/cli.js member:add --name Avery --kind kid --age 15
node dist/cli.js import:chores   "Chore Board.csv"   # Chore, Kid, Mon..Sun, Points
node dist/cli.js import:workouts "MH Workouts.csv"   # person column -> member key
node dist/cli.js import:meals    "MH Meals.csv"      # keeps original meal ids
node dist/cli.js profile:set --member ty --start 2026-09-28 --days 1,2,4,5 \
  --calories 2700 --protein 190 --carbs 300 --fat 85 \
  --breakfast "4 whole eggs + 2 slices toast with butter" \
  --shake "2 scoops whey + banana + 1 tbsp peanut butter + 1 cup A2 whole milk (~590 cal / 60g protein)" \
  --cardio "2–3 incline treadmill walks/week · 20–30 min · 10–12% incline · 3.0–3.5 mph"
node dist/cli.js profile:set --member kayla --start 2026-09-28 --days 1,2,4,5 \
  --calories 2300 --protein 175 --carbs 260 --fat 75 ...same breakfast/shake/cardio
```

The profile values above are the script's `MH_PROFILE`, moved into data.

## Deploy

Push to `main`. `.github/workflows/deploy.yml` mirrors Opsentra's pipeline:

1. Typecheck.
2. SSH with the `DROPLET_SSH_KEY` secret.
3. Snapshot `/opt/myday`.
4. rsync the source. The droplet keeps no git clone.
5. `docker compose build`, then `up -d --force-recreate`. Each step runs alone, with a 45-minute timeout.
6. Health-check `https://staging.conquermyday.app/api/health`.

Migrations run on container start. Config lives only in `/opt/myday/.env` on the droplet; see `api/.env.example`.

The first deploy needs three things set up first:

1. Run `deploy/bootstrap-droplet.sh` on the droplet. It creates the `myday` role and database with new credentials and writes the `.env`.
2. Add the `deploy/Caddyfile.snippet` block to Opsentra's Caddyfile.
3. Add a Cloudflare DNS `A` record: `staging` → `159.223.163.99`, set to DNS only (grey cloud).

## Sign-in

Sign-in uses Google OAuth with sessions stored in Postgres; the cookie lasts 180 days and renews with use. Only emails on the household roster (`household_members.email`) or in `ALLOWED_EMAILS` can sign in.

`DEV_LOGIN_TOKEN` enables `/dev-login?token=…&member=<key>` for verification. It is **temporary** and off by default; blank it once Google sign-in works.

## Port notes (behavior vs. the Apps Script)

- **Points:** checking a chore writes a completion plus a ledger row (`scores`) at once. Unchecking removes both, just as un-ticking a Chore Board cell did.
- **Perfect Week:** every scheduled chore Mon..today must be done, with no homework hanging (undone and due ≤ today, or undated). It pays only on Sunday, once per week, and the bonus equals the week's earned chore + homework points. It's checked on the server whenever a day's last chore is checked off.
- **Streaks:** adults only. Kids keep the positive-only economy: no streaks, no comparison.
- **Grocery:** a single household list, using the same ingredient-merge algorithm as `apiGroceryFromWeek`.
