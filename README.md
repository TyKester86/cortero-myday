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
- drives everything over HTTP: sign-in, kid PINs and 403s, chores, homework, Perfect Week, XP level-ups, rewards approval and history, habits, the per-day meal plan with slots, the grocery rebuild, the adult engine, achievements and streak bonuses, battles, Red Alert, brain dump, family, household and invites, kid devices, money and the chat.
- runs Money against the **fake provider** (`MONEY_PROVIDER=fake`) and Ask Hana / the tutor against a **stub model** (`CHAT_STUB=1`). Both switches are refused in production.

The suite always creates its database as UTF-8, and `migrate` refuses to run on anything else (emoji live in names, notes and achievements).

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

**Other grown-ups** join by invite: ☰ → *Household* → *Invite a grown-up* adds them to the roster with their Google email and gives you a one-time link (valid 14 days; only its hash is stored). Their first sign-in marks the invite accepted.

**Kids** don't need Google. A parent opens ☰ → *Household* → *Kid sign-in* and creates or chooses a 6-digit PIN for each kid on the roster.

- Weak PINs (runs like 123456, repeats like 123123, too few distinct digits) are refused.
- The PIN is shown once and stored only as a salted scrypt hash.
- Setting a new PIN, or turning PIN sign-in off, signs that kid out everywhere.
- Five wrong PINs lock that kid's sign-in for 15 minutes. Each IP also gets at most 20 attempts per 15 minutes.
- Kids sign in with first name + PIN, and still only see and act on their own day.
- *Remember me on this device*, or a parent's *Set up this device for them*, puts the kid's name on that device's sign-in screen, so they just tap and type the PIN. The device holds a random cookie; the server keeps its hash. Parents can forget a device, and a kid can tap "not me".
- Parents see each kid's last sign-ins, including wrong PINs, with a coarse device label (iPhone, Android, Windows…).

**Removing** someone from the household archives them. Their history and points stay, but they can't sign in and drop out of every list. *Restore* brings them back.

## AI (Ask Hana + homework tutor)

Ask Hana (grown-ups) and the tutor (kids and the student track) call Claude through the official `@anthropic-ai/sdk`. The setup:

- **Key:** `ANTHROPIC_KEY`.
- **Model:** `claude-opus-5-5`, or set `CHAT_MODEL` to change it.
- **Effort:** `low`, since these are short chat replies.
- **Refusals:** server-side refusal fallbacks are on (`fallbacks: "default"`).
- **Prompts and limits:** the system prompts, context and reply limits are the script's `chatSystem_` / `chatDayContext_`.
- **History:** stored in `chat_messages`, and the model sees the last 10 turns.
- **Rate limit:** 30 messages per person per hour.

## Money (Plaid, read-only)

Money is grown-ups only. It links a bank through Plaid Link and syncs accounts plus 120 days of transactions into Postgres. From those it computes:

- **Subscription radar:** a charge counts as recurring when it has 3+ occurrences, 80%+ of the gaps fit weekly, biweekly, monthly or yearly, and the amounts stay within 25% of the median.
- **Paycheck detection:** the same rules, applied to deposits.
- **Safe to spend:** checking balance − recurring charges due before the next paycheck, or the next 14 days when no paycheck is detected.

Keys come from `PLAID_CLIENT_ID`, `PLAID_SECRET` and `PLAID_ENV` (`sandbox` or `production`). Bank access tokens are AES-256-GCM encrypted with `MONEY_TOKEN_KEY`. Nothing in the app can move money.

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

- **Adult engine:** morning check-in, energy-tagged tasks, evening review and the weekly habit grid pay the script's XP. Check-in is +5 and review +10 (first save of the day only), a task +5 (student: +10, or +25 for an MIT), and a habit day +3 (un-ticking takes it back).
- **Daily score:** the 5 × 20 parts of `scoreToday_`. 100/100 pays +50 XP once a day.
- **Streak bonuses:** +20 at 7 days (student: +35), +100 at 30, +200 at 90.
- **Achievements:** the script's list. Four student badges that need the academic engine are left out.
- **Boss battles:** the script's list per role, one active at a time, +100 XP (student: +200).
- **Red Alert:** the script's restart steps, +5 XP at most once a day.
- **Family:** the partner check-in pays +15 XP and the first 1-on-1 of the week +20, both once a week. Curfews: Friday and Saturday nights use the weekend times.
- **Meals:** each planned meal can sit in a breakfast, lunch or dinner slot, sorted in that order within the day.

Roster XP tracks: `member:add --track leader|woman|student|kid` (or edit them on the Household page). The defaults are `leader` for adults and `kid` for kids.
