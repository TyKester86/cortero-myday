# The Big Build — report

Commit `6bbee53` on `main` · 219 files · +14,345 / −389 · e2e **453 passed, 0 failed** · meal library **120 meals**.

The e2e gate runs against real Postgres as a non-superuser role, so row-level security is enforced. The stand-ins used in the gate are all refused when `NODE_ENV=production`:

| Stand-in | What it does |
| --- | --- |
| `TRANSCRIPTION_STUB` | Returns a canned photosynthesis lecture |
| `PUSH_STUB` | Records nudges instead of sending them |
| `CLASSROOM_PROVIDER=fake` | Provides 3 sample courses |
| `MONEY_PROVIDER=fake` | Uses demo bank data |
| `CHAT_STUB` | Gives deterministic replies and Hana intents |

## File by file

### Database (`api/migrations`)

#### `004_households_rls_events.sql`
- **Households:** adds a `households` table (type, family code, trial end date, teen-bank gate, onboarding progress). Existing data becomes household 1.
- **Row-level security:** adds `household_id` to 40 tables. Each one gets RLS that is forced even for the table owner, with a policy of "same household, or system scope".
- **Uniqueness:** some unique keys are now per household (member keys, settings, custom stores, staples).
- **Events:** adds the `events` table with an append-only trigger.

#### `005_big_build.sql`
- **Member fields:** school, first-run flag, theme, accent, recording acknowledgement.
- **Meals:** slug, picture, servings, prep time, phase tags.
- **Programs:** build, level, bodyweight and food protein on health profiles, plus the `program_phases` and `workout_moves` tables.
- **School:** classes, lectures, note drafts, flashcards (Leitner box), quiz attempts and lecture assignments. The student engine adds assignments, study sessions, exams and campus contacts/visits.
- **Identity tools:** anchor, monthly reviews, household surveys, mental load.
- **Manual money:** bills, income sources, money check-ins.
- **Kid money:** allowances, kid ledger, savings goals. `money_items.member_id` supports teen bank links.
- **Notifications:** push subscriptions, notification prefs, notification log (one nudge per person per day).
- **Offline:** `idempotency_keys` for replayed writes.
- **Hana:** `hana_actions`, which holds proposed actions awaiting confirmation.
- **Engagement:** quests, family challenges, private notes, Sunday rituals, and a quest source for scores.

### API core (`api/src`)

| File | Change |
| --- | --- |
| `db.ts` | Per-request connection (AsyncLocalStorage) tagged with the household. Adds `asSystem`, `inHousehold`, `detached` (post-response jobs) and a scope-aware `tx`. |
| `auth.ts` | Signup for anyone (gated by `SIGNUP_OPEN`). Invite tokens carried through Google sign-in. Dev login supports `&email=` for signup testing. Kid login resolves the household from the family code or a remembered device. `/api/me` returns household and prefs. Sign-ins are logged. |
| `server.ts` | Middleware order: request scope → session → user → raw uploads → JSON → CSRF → auth → idempotency → households → household gate → module usage → routers. Also serves `/sw.js` no-cache and starts the schedulers. |
| `config.ts` | Adds `signupOpen`. |
| `types.d.ts` | Adds `req.householdId`. |
| `migrate.ts` | Refuses a non-UTF8 database. |
| `cli.ts` | Commands are household-aware (`--household`). Adds `household:list`, `plan:load` and `meals:seed`. |

### API libraries (`api/src/lib`)

| File | Purpose |
| --- | --- |
| `events.ts` | `logEvent()`, which never throws. |
| `requestlog.ts` | Idempotent replay of offline writes, plus a `module_used` event once per day. |
| `schedulers.ts` | Interval jobs; turned off with `SCHEDULERS=off`. |
| `program.ts` | Exercise library, 9 build templates, 52-week phases, deloads, dosing, macros. |
| `planload.ts` | Writes a build plan or a CSV plan into the plan tables. |
| `transcribe.ts` | Whisper-compatible speech-to-text, or the stub. |
| `lecturenotes.ts` | Claude structured output (zod schema) that turns a transcript into notes, terms, flashcards and assignments with resolved due dates. Has a deterministic local structurer for tests. |
| `hana.ts` | 10 tools. 7 safe ones (task, complete task, groceries, note, homework, move workout, bill) run immediately. 3 destructive ones (delete task, clear checked groceries, remove bill) are only proposed and need confirmation. |
| `ai.ts` | Manual tool-use loop (5 rounds max, refusal-aware). The stub follows deterministic intents. |
| `push.ts` | Copy policy (guilt words and phrases, shouting and all caps are refused outright), quiet hours, one batched digest per day, VAPID web-push. |
| `adult.ts` | Student score part "Study/assignment" plus the 4 restored badges. |
| `stores.ts` | `orderUrl` for each grocery chain. |

### API routes (`api/src/routes`)

**New:**

| File | Covers |
| --- | --- |
| `households.ts` | Create a household, settings, onboarding steps, school autocomplete |
| `program.ts` | Build choice and program status |
| `school.ts` | Classes, assignments, study log, exams, campus, Google Classroom |
| `lectures.ts` | Upload, pipeline, privacy, scaffold, study library, tutor material |
| `identity.ts` | Identity tools |
| `bills.ts` | Bills, income, money check-in |
| `kidmoney.ts` | Kid/teen money plus the allowance job |
| `engagement.ts` | Quests, challenge, wins, Sunday, focus, prefs, private notes |
| `notifications.ts` | Notification prefs, subscribe, test, digest job |
| `records.ts` | Records history and CSV |
| `index.ts` | Router registry |

**Changed:**

| File | Change |
| --- | --- |
| `health.ts` | Plan-only today, move, any-workout log, history, baseline, 52-week plan |
| `meals.ts` | Pictures, phase filter |
| `money.ts` | Household view excludes teen links; shared helpers |
| `day.ts` | Energy-aware task order |
| `chat.ts` | Hana tools, confirm/cancel, tutor lecture quiz |
| `household.ts` | Cross-household email check, school field, events |
| `chores.ts`, `homework.ts`, `rewards.ts` | Events |

### Web (`web/src`)

**New screens:**

| Area | Files |
| --- | --- |
| Onboarding | `Onboarding.tsx` (create household, setup funnel with QR) |
| School | `School.tsx`, `Recorder.tsx`, `Lecture.tsx`, `Study.tsx`, `ClassroomMode.tsx` |
| Identity | `identity/Identity.tsx` |
| Money | `money/Bills.tsx`, `kidmoney/KidMoney.tsx` |
| Engagement | `Wins.tsx` (quests, challenge, feed, Sunday), `Focus.tsx`, `Private.tsx` |
| Settings | `settings/Settings.tsx` (look, notifications, household gate) |
| Records | `records/Records.tsx` |
| Desktop | `CommandCenter.tsx`, `Home.tsx` |
| Health | `Program.tsx` (build picker, program card) |

**New components:** `Confirm.tsx`, `QuickNote.tsx`, `FirstRun.tsx`, `Shortcuts.tsx`, `QR.tsx`.

**Changed screens:**

| File | Change |
| --- | --- |
| `HealthToday.tsx` | Plan-driven; build picker, program, move workout, logs, baseline |
| `HealthPlan.tsx` | 52-week grid |
| `Meals.tsx` | Picture grid, phase filter |
| `MealDetail.tsx` | Picture, add to week on chosen days |
| `Grocery.tsx` | One-tap store ordering, copy list |
| `Chat.tsx` | Confirm cards, quiz mode, fix for the Chrome `scrollIntoView` Promise crash |
| `HomeChores.tsx` | Quests, quick note, NOW animation |
| `MyDay.tsx` | Energy note, quick note |
| `Login.tsx` | Landing, family code, trial |
| `App.tsx` | Onboarding gate, theme, offline bar, first run, shortcuts, wide desktop |
| `api.ts` | Offline write queue with Idempotency-Key replay |
| `session.tsx` | Handles a user with no household |
| `main.tsx` | Service worker registration |
| `index.tsx` | Routes |
| `styles.css` | Themes, accents, new UI, desktop-only rules |

**Native dialog removal:** `Battles.tsx`, `KidAccess.tsx`, `ManageChores.tsx`, `Homework.tsx`, `Household.tsx`, `MealPlan.tsx` and `Money.tsx` replaced native `confirm()` with the in-page modal.

**Public files:** `web/public/sw.js` (offline reads, push display, clears cache on sign-out) and `web/public/meals/*.svg` (120 pictures plus a placeholder).

### Content, scripts, deploy

| File | Change |
| --- | --- |
| `api/content/meals.csv` | 120 meals, 23 cuisines, calories recomputed as 4P+4C+9F, rounded to 10 |
| `scripts/gen-meal-images.mjs` | Meal picture generator |
| `scripts/e2e.mjs` | +191 checks, including the Playwright UI gate |
| `scripts/button-audit.mjs` | Traces 176 buttons, 138 API calls and 15 links; no dead controls |
| `Dockerfile` | Content files, meal seed on start, `/data/uploads` |
| `docker-compose.yml` | `myday-data` volume, `UPLOAD_DIR` |
| `api/.env.example` | New variables |

## My reading of the numbers

### Shakes per day
Formula: shakes/day = round((bodyweight × target g/lb − food protein) ÷ 25), never below 0.

| | Gaining | Cutting | Recomp | Maintenance |
| --- | --- | --- | --- | --- |
| Protein target (g/lb) | 0.8 | 1.05 | 0.9 | 0.7 |
| 180 lb man, 100 g food | 2 | 4 | 2 | 1 |
| 140 lb woman, 80 g food | 1 | 3 | 2 | 1 |

These match the ranges in the spec. Default food protein is 100 g for men and 80 g for women; users can change it.

### Macros
- **Maintenance:** bodyweight × 15 kcal.
- **Gain and cut:** maintenance ± (bodyweight × weekly % ÷ 100) × 500 kcal/day.
- **Split:** protein comes from the phase target, fat is 0.35 g/lb, carbs are the remainder.
- **Example, 180 lb V-taper:** hypertrophy 3020 kcal / 144 P / 469 C / 63 F; cut 2160 kcal / 189 P / 209 C / 63 F.

### Programs
- **Year shape:** every build has 52 contiguous weeks. Every 5th week is a deload at about half volume.
- **Experienced:** foundation → hypertrophy → strength → cut → maintenance.
- **Beginners:** 16-week recomp, then hypertrophy 16, cut 16, maintenance 4.
- **Volume:** priority muscles get 10–20 sets a week, trained twice a week. No muscle goes above 26 sets.
- **Strength:** strength blocks use 3–5 rep work.
- **Hourglass:** a glute pattern plus a squat pattern on each lower-body day.
- **Late cut:** volume drops 20%.

### Meals
- **Library:** 120 meals.
- **Phase tags:** cutting 64, gaining 41, recomp 105, maintenance 118.

### Lecture scaffold
- **1st–2nd lecture in a class:** notes appear right away.
- **3rd–5th lecture:** the student drafts the summary first.
- **6th lecture onward:** the student drafts the key points first.
- **Audio:** deleted once it has been transcribed.

### Push
- **Frequency:** at most one batched nudge per person per day.
- **Timing:** sent only after the chosen time, never inside quiet hours.
- **Opt-in:** each topic (bills, chores, homework) is on or off per person.

### Teens and kids
- **Teen:** 13 or older.
- **Teen bank link:** read-only. Only a parent completes or revokes it, and only with the household gate on.
- **Allowance:** paid on the chosen weekday, with no back pay for a new allowance and at most 4 weeks of catch-up.

### Quests
Three of eight rotate each week per kid, chosen deterministically from week + member.

## Environment variables (all in `/opt/myday/.env`, never in git)

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `SESSION_SECRET`, `PUBLIC_URL`, `PORT`, `TZ_HOUSEHOLD` | Core |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS` | Google sign-in, also used for Classroom import |
| `DEV_LOGIN_TOKEN` | Temporary verification; blank it in production use |
| `SIGNUP_OPEN` | `true` lets anyone with Google create a household |
| `ANTHROPIC_KEY`, `CHAT_MODEL` | Hana, tutor, lecture notes |
| `TRANSCRIPTION_KEY`, `TRANSCRIPTION_URL`, `TRANSCRIPTION_MODEL` | Lecture speech-to-text (Whisper-compatible) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `MONEY_TOKEN_KEY` | Read-only bank links |
| `UPLOAD_DIR` | Lecture audio staging (set by compose to `/data/uploads`) |
| `SCHEDULERS` | `off` disables background jobs |
| `MONEY_PROVIDER=fake`, `CHAT_STUB`, `TRANSCRIPTION_STUB`, `PUSH_STUB`, `CLASSROOM_PROVIDER=fake` | Local proof only; refused in production |

## Known limits
- **Web app:** it can't lock a phone. Classroom Mode tells parents how to use Guided Access, Screen Time or app pinning.
- **Offline writes:** they are queued on the device and replayed. Chat, sign-in, uploads and link flows are not queued.
- **FIX 17 parity:** the live FIX 17 couldn't be inspected. Parity was taken from `myday-app.gs`, which goes up to FIX 7.
