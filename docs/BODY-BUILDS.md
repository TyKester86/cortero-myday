# Body builds: the rules the app follows

The nine builds follow the research report "Evidence for the nine body builds". The safety rules come first. The code lives in `api/src/lib/program.ts` (plans and food math), `api/src/routes/program.ts` (gates, check-ins, weigh-ins) and `shared/src/index.ts` (formulas and constants). The full test gate checks every rule below.

## Safety

| # | Rule | Where |
|---|---|---|
| 1 | **Teen mode** applies to anyone under 18 or any kid on the roster. Builds become training styles (Athletic, Strong, Power, Runner). There are no calorie, weight or shake targets, no weigh-ins, no shake or creatine habits, no cut and no Shredded. | `isTeen`, `TEEN_STYLE`, `buildPhases({ teen })` |
| 2 | **Deficits** are capped at 500 kcal/day (750 kcal/day with BMI ≥ 30), and never more than 1% of bodyweight a week. **Floors** are 1,200 kcal/day for women and 1,500 for men. Lean Runner holds its running volume flat during the deficit block. | `energyFor`, `RUNNER_CARDIO.cutting` |
| 3 | **Check-ins every 4 weeks** apply to women whose year includes a cut, Lean Runner and Shredded. They ask about periods, bone-stress injury, fatigue, food worries, sleep and aches. Red flags pause any cut until a clinician clears it: 3+ months without a period, a bone-stress injury, or food running your life. Soft flags (aches, sleep, fatigue) suggest a deload. | `POST /api/program/checkin`, `/resume` |
| 4 | **Reference weight** drives protein, fat and shakes. It is the lowest of current weight, goal weight and, when BMI ≥ 30, the weight at BMI 25. Shakes are rounded up and capped at 3 a day. | `referenceWeightLb`, `shakesPerDay` |
| 5 | **Shredded** is for adults with a year or more of lifting. It requires a 5-question eating-disorder screen (2+ "yes" refers the person to a doctor or dietitian) and a disclosure of the costs. The cut is 16 weeks, followed by 8 required weeks of maintenance. Beginners are routed to Lean Athletic. "I need a break" pauses the cut for a week. | `PUT /api/program` |
| 6 | **Weigh-ins** are off by default and only ever shown as a 7-day average. The API never returns a single day's weight. There are no progress photos and no streak shaming. | `/api/weigh-ins` |
| 7 | **Run cap:** no single run may be more than 10% longer than the longest run in the past 30 days. A run over the cap triggers a warning. The "10% a week" rule is gone. | `runCapFor` |
| 8 | **Pregnancy or postpartum** requires the clinician's OK first, and the plan never includes a cut. In pregnancy there are no calorie targets. | `clinician_needed` |

## Results

- **Calories:** Mifflin-St Jeor resting energy × an activity factor. Every 2 weeks the estimate is nudged by up to ±250 kcal from the 7-day weight trend. The first 2 weeks of each phase are ignored.
- **Year maps** are per build. Thick & Powerful, Strong & Dense and Strong & Curvy have no cut. Lean Runner never runs a surplus. Users with higher body fat start with the cut.
- **Sets** are counted fractionally: a press counts as ½ a set for triceps. The limits are ≤ 25 sets per muscle per week and ≤ 11 per session. Priority muscles get 10–25 sets.
- **Beginner ramp:** about half the sets in the first month and about ¾ through week 16.
- **First 28 days:** short sessions (4 exercises), with attendance as the goal. Two sessions in a week counts as a "minimum week".
- **Effort:** every prescription carries RIR (reps in reserve). The "Next:" hint applies double progression.
- **Library additions:** leg extension, seated leg curl (now the default), dumbbell shrug, farmer's carry, cable crunch, box jumps, pogo hops and seated calf raise.
- **Missed weeks:**

  | Time off | What happens |
  |---|---|
  | 1–2 weeks | Resume about 10% lighter |
  | 3–8 weeks | 2 ramp weeks at ~60% of the sets |
  | Longer | Restart the current phase (not week 1) |

- **Cuts** hold load, effort and volume. The old "late cut −20%" phase is gone.

## Nice to have

- **Deloads** come every 6 weeks (every 8 for beginners), plus "Take a deload week" on demand. They are suggested when lifts stall or the check-in mentions aches or poor sleep.
- **The year in chapters:** four ~13-week chapters, each one a fresh start ("start here" on the plan page).
- **Exercise rotation:** variants rotate every 3–4 weeks. Main lifts never rotate.
- **Adult notes:** creatine, diet breaks, sleep, and notes for people over 40 and around menopause.

## Still needed

Five new exercises have no demo render yet. Add the files to `web/public/exercises/` and run `node scripts/exercise-pictures.mjs`:

- Seated leg curl
- Dumbbell shrug
- Farmer's carry
- Box jump
- Pogo hops

The old `leg-curl.webp` render shows a lying curl. It is now `lying-leg-curl.webp`, so it no longer appears under the seated curl.
