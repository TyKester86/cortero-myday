/**
 * H4 — the homework & routine coach. Captured assignments become a plan: a start-by
 * date, ONE visible next action at a time, nudges BEFORE the due date, visible progress,
 * finished work celebrated — never a wall of overdue red (ADHD-fit: short horizons).
 *
 * Escalation is gentle and rare: a parent is looped in only when an assignment is at
 * real risk — its start-by date has passed with no progress signal — and only once per
 * assignment. A nudge someone dismissed stays dismissed for that assignment.
 *
 * Hana writes only her own records here (progress steps, dismissals, hana_items);
 * the homework list itself is untouched.
 */
import type { DateStr, HanaCoach, HanaCoachPlan, HouseholdMember } from '@myday/shared';
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { addDays, today } from '../dates.js';
import { logEvent } from '../events.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';
import { choresFor, homeworkFor } from './tools.js';
import { type Viewer } from './scope.js';
import { SOURCE } from './facts.js';

/** Start two days before it's due (or today, if that's already passed when it was added). */
export const LEAD_DAYS = 2;

const weekday = (d: DateStr): string => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });

function nextAction(step: number, assignment: string): string {
  switch (step) {
    case 0:
      return `Start: open ${assignment} and do the first 10 minutes.`;
    case 1:
      return `Keep going: one 20-minute chunk on ${assignment}.`;
    case 2:
      return `Finish ${assignment} and check it over.`;
    default:
      return `${assignment} is ready — hand it in, then check it off in Homework.`;
  }
}

function whenLabel(startBy: DateStr, due: DateStr, t: DateStr): string {
  if (due < t) return 'Still open';
  if (startBy > t) return `Start ${startBy === addDays(t, 1) ? 'tomorrow' : weekday(startBy)}`;
  if (due === t) return 'Due today';
  if (due === addDays(t, 1)) return 'Due tomorrow';
  return startBy === t ? 'Start today' : `Due ${weekday(due)}`;
}

interface PlanRow {
  id: number;
  member_id: number;
  assignment: string;
  due: DateStr;
  created_on: DateStr;
  step: number;
}

/** Open homework with a due date, with its progress step and start-by date. */
async function plansOf(memberIds: number[]): Promise<Array<PlanRow & { startBy: DateStr }>> {
  const { rows } = await pool.query<PlanRow>(
    `SELECT h.id, h.member_id, h.assignment, h.due::text AS due, (h.created_at AT TIME ZONE $2)::date::text AS created_on, COALESCE(s.step, 0) AS step
       FROM homework h LEFT JOIN hana_homework_steps s ON s.homework_id = h.id
      WHERE h.member_id = ANY($1::int[]) AND NOT h.done AND h.due IS NOT NULL
      ORDER BY h.due, h.id`,
    [memberIds, config.tz],
  );
  return rows.map((r) => {
    const ideal = addDays(r.due, -LEAD_DAYS);
    return { ...r, startBy: ideal < r.created_on ? (r.created_on < r.due ? r.created_on : r.due) : ideal };
  });
}

/** Whose coach a viewer may see: a kid, their own; a parent, any kid. */
export async function coachTarget(v: Viewer, key: string | null): Promise<HouseholdMember> {
  if (!v.parent) {
    if (key && key !== v.me.key) throw new HttpError(404, 'You can only see your own plan');
    return v.me;
  }
  const kids = (await listMembers()).filter((m) => m.kind === 'kid');
  const who = key ? kids.find((m) => m.key === key) : kids[0];
  if (!who) throw new HttpError(404, 'No such kid in this household');
  return who;
}

export async function coachFor(v: Viewer, member: HouseholdMember): Promise<HanaCoach> {
  const t = today();
  const hw = await homeworkFor(v, null, [member]);
  const conflictOf = new Map(hw.data.map((h) => [h.id, h.conflict]));
  const plans = (await plansOf([member.id])).map(
    (p): HanaCoachPlan => ({
      homeworkId: p.id,
      assignment: p.assignment,
      due: p.due,
      startBy: p.startBy,
      step: p.step as HanaCoachPlan['step'],
      nextAction: nextAction(p.step, p.assignment),
      when: whenLabel(p.startBy, p.due, t),
      stillOpen: p.due < t,
      check: conflictOf.get(p.id) ?? null,
      source: SOURCE.homework,
    }),
  );
  // One thing at a time: the upcoming plan whose start-by comes first. Anything already past its date
  // comes after it, most recent first — "still open", gently, never a wall of red.
  const upcomingFirst = plans.filter((p) => !p.stillOpen).sort((a, b) => a.startBy.localeCompare(b.startBy) || a.due.localeCompare(b.due));
  const stillOpen = plans.filter((p) => p.stillOpen).sort((a, b) => b.due.localeCompare(a.due));
  const ordered = [...upcomingFirst, ...stillOpen];
  const focus = ordered[0] ?? null;
  const rest = ordered.slice(1);
  const soon = rest.filter((p) => !p.stillOpen && p.due <= addDays(t, 7));
  const { rows: fin } = await pool.query<{ assignment: string }>(
    'SELECT assignment FROM homework WHERE member_id = $1 AND done AND done_on >= $2 ORDER BY done_on DESC, id DESC LIMIT 3',
    [member.id, addDays(t, -3)],
  );
  const own = v.me.id === member.id;
  const celebrate = fin.map((f) => (own ? `You finished ${f.assignment}. Nice work.` : `${member.name} finished ${f.assignment}.`));
  // A nudge (the kid's own view): on the start-by day or the day before it's due — unless they set it aside.
  let nudge: HanaCoach['nudge'] = null;
  if (own && focus && focus.step < 3 && !focus.stillOpen && (focus.startBy <= t || focus.due === addDays(t, 1))) {
    const { rowCount } = await pool.query("SELECT 1 FROM hana_dismissals WHERE member_id = $1 AND kind = 'nudge' AND ref = $2", [member.id, String(focus.homeworkId)]);
    if (!rowCount) {
      const text =
        focus.due === addDays(t, 1)
          ? `${focus.assignment} is due tomorrow. One more chunk and you’re there.`
          : focus.step === 0
            ? `Today’s a good day to start ${focus.assignment} — just 10 minutes.`
            : `Keep ${focus.assignment} rolling — one small chunk today.`;
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO hana_items (member_id, surface, category, item_key, subject_member_id, text, source, as_of, shown_on)
         VALUES ($1, 'nudge', 'homework', $2, $1, $3, $4, now(), $5)
         ON CONFLICT (member_id, surface, item_key, shown_on) DO UPDATE SET text = EXCLUDED.text RETURNING id`,
        [member.id, `nudge:${focus.homeworkId}`, text, SOURCE.homework, t],
      );
      nudge = { homeworkId: focus.homeworkId, text, itemId: rows[0]?.id ?? 0 };
    }
  }
  const ch = (await choresFor(v, t, member.name)).data[0];
  return {
    member: { id: member.id, name: member.name },
    focus,
    upcoming: soon.slice(0, 3),
    moreLater: Math.max(0, rest.length - Math.min(3, soon.length)),
    celebrate,
    nudge,
    chores: ch
      ? { done: ch.chores.filter((c) => c.done).length, total: ch.chores.length, pending: ch.chores.filter((c) => !c.done).map((c) => c.name), points: ch.points, reward: ch.reward }
      : null,
  };
}

/** The kid (or a parent) moves the plan along: the progress signal. */
export async function setStep(v: Viewer, homeworkId: number, step: number): Promise<void> {
  if (!Number.isInteger(step) || step < 0 || step > 3) throw new HttpError(400, 'Step is 0–3');
  const { rows } = await pool.query<{ member_id: number }>('SELECT member_id FROM homework WHERE id = $1', [homeworkId]);
  const owner = rows[0]?.member_id;
  if (owner === undefined) throw new HttpError(404, 'No such homework');
  if (owner !== v.me.id && !v.parent) throw new HttpError(404, 'No such homework');
  await pool.query(
    `INSERT INTO hana_homework_steps (homework_id, step, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (homework_id) DO UPDATE SET step = EXCLUDED.step, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [homeworkId, step, v.me.id],
  );
}

/** "Not now" on a nudge: it stays dismissed for that assignment. */
export async function dismissNudge(v: Viewer, homeworkId: number): Promise<void> {
  const { rows } = await pool.query<{ member_id: number }>('SELECT member_id FROM homework WHERE id = $1', [homeworkId]);
  if (rows[0]?.member_id !== v.me.id) throw new HttpError(404, 'No such nudge');
  await pool.query("INSERT INTO hana_dismissals (member_id, kind, ref) VALUES ($1, 'nudge', $2) ON CONFLICT DO NOTHING", [v.me.id, String(homeworkId)]);
  await pool.query("UPDATE hana_items SET outcome = 'dismissed', outcome_at = now() WHERE member_id = $1 AND surface = 'nudge' AND item_key = $2 AND outcome IS NULL", [v.me.id, `nudge:${homeworkId}`]);
  await logEvent('hana_item_outcome', { outcome: 'dismissed', surface: 'nudge' }, v.me.id);
}

/**
 * Real risk: the start-by date has passed and there is no progress signal (no step, not
 * done). Each parent is told once per assignment — gently — and never again for it.
 * Returns how many new escalations were written.
 */
export async function refreshEscalations(): Promise<Array<{ parentId: number; text: string; key: string }>> {
  const t = today();
  const members = await listMembers();
  const kids = members.filter((m) => m.kind === 'kid');
  const parents = members.filter((m) => m.kind === 'adult');
  if (!kids.length || !parents.length) return [];
  const byId = new Map(kids.map((k) => [k.id, k]));
  const out: Array<{ parentId: number; text: string; key: string }> = [];
  for (const p of await plansOf(kids.map((k) => k.id))) {
    // At risk: start-by passed, no progress, and it isn't long gone (due yesterday or later).
    if (!(p.startBy < t && p.step === 0 && p.due >= addDays(t, -1))) continue;
    const kid = byId.get(p.member_id);
    if (!kid) continue;
    const key = `atrisk:${p.id}`;
    const text = `${kid.name} hasn’t started ${p.assignment} yet — the plan was to start ${weekday(p.startBy)}, and it’s due ${p.due === t ? 'today' : weekday(p.due)}. A quick, kind check-in might help.`;
    for (const parent of parents) {
      const { rowCount } = await pool.query('SELECT 1 FROM hana_items WHERE member_id = $1 AND surface = $2 AND item_key = $3', [parent.id, 'escalation', key]);
      if (rowCount) continue; // once per assignment, ever
      await pool.query(
        `INSERT INTO hana_items (member_id, surface, category, item_key, subject_member_id, text, source, as_of, shown_on)
         VALUES ($1, 'escalation', 'homework', $2, $3, $4, $5, now(), $6) ON CONFLICT DO NOTHING`,
        [parent.id, key, kid.id, text, SOURCE.homework, t],
      );
      out.push({ parentId: parent.id, text, key });
    }
  }
  return out;
}
