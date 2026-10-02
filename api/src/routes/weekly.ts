/**
 * Weekly Plan: theme, top priority, energy plan, focus, RSD plan, review
 * notes for the week (Mon start). Ported from apiAdultWeekly /
 * apiAdultSaveWeekly, with the original field length limits.
 */
import { Router } from 'express';
import type { DateStr, WeeklyPlan, WeeklyPlanResponse } from '@myday/shared';
import { pool } from '../db.js';
import { addDays, today, weekStart } from '../lib/dates.js';
import { str } from '../lib/http.js';
import { targetMember } from '../lib/members.js';

export const weeklyRouter = Router();

interface WeeklyRow {
  week_start: DateStr;
  theme: string;
  top: string;
  energy: string;
  focus: string;
  rsd: string;
  review: string;
}

function toPlan(r: WeeklyRow | undefined): WeeklyPlan | null {
  if (!r) return null;
  return { weekStart: r.week_start, theme: r.theme, top: r.top, energy: r.energy, focus: r.focus, rsd: r.rsd, review: r.review };
}

weeklyRouter.get('/api/weekly-plan', async (req, res) => {
  const member = await targetMember(req);
  const ws = weekStart(today());
  const prev = addDays(ws, -7);
  const { rows } = await pool.query<WeeklyRow>(
    `SELECT week_start, theme, top, energy, focus, rsd, review FROM weekly_plans
      WHERE member_id = $1 AND week_start IN ($2, $3)`,
    [member.id, ws, prev],
  );
  const out: WeeklyPlanResponse = {
    member,
    weekStart: ws,
    current: toPlan(rows.find((r) => r.week_start === ws)),
    previous: toPlan(rows.find((r) => r.week_start === prev)),
  };
  res.json(out);
});

weeklyRouter.put('/api/weekly-plan', async (req, res) => {
  const member = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  await pool.query(
    `INSERT INTO weekly_plans (member_id, week_start, theme, top, energy, focus, rsd, review)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (member_id, week_start) DO UPDATE SET
       theme = EXCLUDED.theme, top = EXCLUDED.top, energy = EXCLUDED.energy,
       focus = EXCLUDED.focus, rsd = EXCLUDED.rsd, review = EXCLUDED.review, updated_at = now()`,
    [
      member.id,
      weekStart(today()),
      str(b.theme, 'theme', 100),
      str(b.top, 'top', 200),
      // The script cut this at 20 chars, but the UI is free text ("How will you
      // protect energy?"), so it silently lost input. Raised to 200.
      str(b.energy, 'energy', 200),
      str(b.focus, 'focus', 200),
      str(b.rsd, 'rsd', 200),
      str(b.review, 'review', 500),
    ],
  );
  res.json({ ok: true });
});
