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
npm run e2e                       # full regression (needs a built tree, see below)
```

### Regression suite

`npm run build && npm run e2e` runs `scripts/e2e.mjs`. The suite:

- creates a throwaway `myday_e2e` database on the Postgres in `E2E_DATABASE_URL` (or `api/.env`'s `DATABASE_URL`), so that role needs CREATE DATABASE;
- seeds the sample fixtures in `scripts/fixtures/`;
- walks the real compiled server through Mon 2026‑09‑28 .. Sun 10‑04, restarting it each day with a test-only clock (`scripts/fake-clock.mjs`, never loaded in production);
- drives everything over HTTP: sign-in, kid PINs and 403s, chores, homework, Perfect Week, XP level-ups, rewards approval, habits, the per-day meal plan, and the grocery rebuild.

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

**Kids** don't need Google. A parent opens ☰ → *Kid sign-in* and creates or chooses a 6-digit PIN for each kid on the roster.

- Weak PINs (runs like 123456, repeats like 123123, too few distinct digits) are refused.
- The PIN is shown once and stored only as a salted scrypt hash.
- Setting a new PIN, or turning PIN sign-in off, signs that kid out everywhere.
- Five wrong PINs lock that kid's sign-in for 15 minutes. Each IP also gets at most 20 attempts per 15 minutes.
- Kids sign in with first name + PIN, and still only see and act on their own day.

`DEV_LOGIN_TOKEN` enables `/dev-login?token=…&member=<key>` for verification. It is **temporary** and off by default; blank it once Google sign-in works.

## Port notes (behavior vs. the Apps Script)

- **Points:** checking a chore writes a completion plus a ledger row (`scores`) at once. Unchecking removes both, just as un-ticking a Chore Board cell did.
- **Perfect Week:** every scheduled chore Mon..today must be done, with no homework hanging (undone and due ≤ today, or undated). It pays only on Sunday, once per week, and the bonus equals the week's earned chore + homework points. It's checked on the server whenever a day's last chore is checked off.
- **Streaks:** adults only. Kids keep the positive-only economy: no streaks, no comparison.
- **Grocery:** a single household list, using the same ingredient-merge algorithm as `apiGroceryFromWeek`, except the script's double-build bug is **fixed**. Each row remembers how much came from the meal plan (`plan_qty`), and a rebuild replaces that share instead of adding to it, so 4 lb stays 4 lb.
- **Homework:** 20 points each (the script's default), paid on check-off. Only grown-ups can delete homework, and only while it's open.
- **Rewards:** a kid's request reserves the points as *pending*. A grown-up approves it (paid out) or denies it (refunded). Bank = points earned − pending − approved, matching how the script counted *Redemptions*.
- **XP:** every point earned is also XP (1:1). The script's adult XP actions (+15 workout, +25 first weekly-plan save; 10 and 20 on the student track) add XP only. Spending never lowers XP. Level tables: `api/src/lib/xp.ts`.
- **Habits:** water, shake and creatine pay 5 points each per day; un-ticking takes them back.

Roster XP tracks: `member:add --track leader|woman|student|kid`. The defaults are `leader` for adults and `kid` for kids.
