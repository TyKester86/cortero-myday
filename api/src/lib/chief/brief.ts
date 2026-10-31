/**
 * H3 — the family brief. Built deterministically from the toolbelt (no model writes a
 * fact here), so every time, pickup, due date and amount is the tool's, with its source.
 *
 *  - morning: today per person, pickups with who's on them, conflicts in plain words,
 *    homework due today/tomorrow, bills due this week (parents), chores and points.
 *  - evening: tomorrow's shape, and anything nobody owns yet.
 *  - weekly: what changed in this family over the last 7 days, and the week ahead.
 *
 * Parents see the whole board; a child sees only their own day (no siblings' items,
 * no grown-ups-only events, no money), in plainer words for younger kids.
 * Every item shown is logged in hana_items with its outcome (H9).
 */
import type { DateStr, HanaBrief, HanaBriefItem, HanaBriefKind, HanaItemOutcome } from '@myday/shared';
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { addDays, today } from '../dates.js';
import { logEvent } from '../events.js';
import { listMembers } from '../members.js';
import { SOURCE, type Fact, type SourceName } from './facts.js';
import { billsDue, choresFor, homeworkFor, scheduleFor, type ScheduleItem } from './tools.js';
import { findConflicts, type ConflictOptions } from './conflicts.js';
import { loopLine, loopsFor } from './loops.js';
import { openText } from '../seal.js';
import { expiryLine, listVault } from './papers.js';
import { moneyBrief } from './money.js';
import type { Viewer } from './scope.js';

export type BriefKind = HanaBriefKind;
export type ItemOutcome = HanaItemOutcome;
export type BriefItem = HanaBriefItem;
export type Brief = HanaBrief;

type Draft = Omit<BriefItem, 'id' | 'outcome' | 'source'> & { source: SourceName };

const clock = (t: string | null): string => {
  if (!t) return 'all day';
  const [h, m] = t.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? ' AM' : ' PM'}`;
};
const span = (e: ScheduleItem): string => (e.time ? `${clock(e.time)}${e.endTime ? `–${clock(e.endTime)}` : ''}` : 'all day');
const dayName = (d: DateStr): string => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });
const shortDay = (d: DateStr): string => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const young = (v: Viewer): boolean => !v.parent && (v.me.age ?? 12) <= 12;

const mins = (t: string): number => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** The conflict engine's household settings, and who the children are. */
export async function conflictOptions(dayLabel: (d: DateStr) => string): Promise<ConflictOptions> {
  const { rows } = await pool.query<{ travel: number; limit: number }>('SELECT travel_minutes AS travel, kid_day_limit AS limit FROM hana_settings LIMIT 1');
  const kids = (await listMembers()).filter((m) => m.kind === 'kid').map((m) => m.name);
  return { travelMinutes: rows[0]?.travel ?? 20, kidDayLimit: rows[0]?.limit ?? 4, kids, dayLabel };
}

function scheduleDrafts(v: Viewer, f: Fact<ScheduleItem[]>, d: DateStr, label: string, opts: ConflictOptions): { schedule: Draft[]; pickups: Draft[]; conflicts: Draft[] } {
  const events = f.data.filter((e) => e.date === d);
  const base = { source: f.source, asOf: f.asOf, check: f.stale };
  const schedule: Draft[] = [];
  if (v.parent) {
    // Per person: everyone's things first, then each person's.
    const groups = new Map<string, ScheduleItem[]>();
    for (const e of events) {
      const k = e.people.length ? e.people.join(' & ') : 'Everyone';
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    for (const [who, list] of [...groups.entries()].sort(([a], [b]) => (a === 'Everyone' ? -1 : b === 'Everyone' ? 1 : a.localeCompare(b)))) {
      schedule.push({
        ...base,
        key: `day:${d}:${who}`,
        category: 'schedule',
        text: `${who}: ${list.map((e) => `${e.title} ${span(e)}${e.adultsOnly ? ' (grown-ups only)' : ''}`).join(' · ')}`,
        subjectId: null,
        headsUp: false,
      });
    }
  } else {
    for (const e of events)
      schedule.push({ ...base, key: `event:${e.eventId}:${d}`, category: 'schedule', text: `${e.title} — ${span(e)}${e.location ? ` at ${e.location}` : ''}`, subjectId: v.me.id, headsUp: false });
  }
  const pickups: Draft[] = events
    .filter((e) => e.pickup)
    .map((e) => ({
      ...base,
      key: `pickup:${e.eventId}:${d}`,
      category: 'pickup' as const,
      text: v.parent
        ? e.pickupBy
          ? `${e.title} (${span(e)}): ${e.pickupBy} is on the pickup.`
          : `${e.title} (${span(e)}): nobody is on the pickup yet${label === 'today' ? ' — someone needs to take it today' : ''}.`
        : e.pickupBy
          ? `${e.pickupBy} is picking you up from ${e.title} (${span(e)}).`
          : `Your ride for ${e.title} isn’t set yet — a grown-up is sorting it out.`,
      subjectId: null,
      headsUp: !e.pickupBy,
    }));
  const conflicts: Draft[] = findConflicts(events, opts)
    .filter((c) => v.parent || c.kidText)
    .map((c) => ({
      ...base,
      key: c.key,
      category: 'conflict' as const,
      text: v.parent ? c.text : (c.kidText as string),
      subjectId: null,
      headsUp: true,
    }));
  return { schedule, pickups, conflicts };
}

async function homeworkDrafts(v: Viewer, from: DateStr, to: DateStr): Promise<Draft[]> {
  const f = await homeworkFor(v);
  const t = today();
  return f.data
    .filter((h) => !h.done && h.due && h.due >= from && h.due <= to)
    .map((h) => ({
      key: `homework:${h.id}`,
      category: 'homework' as const,
      text: `${v.parent ? `${h.member}: ` : ''}${h.assignment}${h.subject ? ` (${h.subject})` : ''} — due ${h.due === t ? 'today' : h.due === addDays(t, 1) ? 'tomorrow' : shortDay(h.due as DateStr)}`,
      subjectId: h.memberId,
      source: f.source,
      asOf: f.asOf,
      check: h.conflict,
      headsUp: !!h.conflict,
    }));
}

async function choreDrafts(v: Viewer, d: DateStr): Promise<Draft[]> {
  const f = await choresFor(v, d);
  return f.data
    .filter((c) => c.chores.length || c.reward)
    .map((c) => {
      const done = c.chores.filter((x) => x.done).length;
      const reward = c.reward ? (c.reward.short ? `${c.reward.short} points from ${c.reward.name}` : `${c.reward.name} is within reach`) : '';
      const chores = c.chores.length ? `${done} of ${c.chores.length} chores done` : 'no chores today';
      return {
        key: `chores:${c.memberId}:${d}`,
        category: 'chores' as const,
        text: v.parent ? `${c.member}: ${chores} · ${c.points} points${reward ? ` · ${reward}` : ''}` : `${chores}. You have ${c.points} points${reward ? ` — ${reward}` : ''}.`,
        subjectId: c.memberId,
        source: f.source,
        asOf: f.asOf,
        check: null,
        headsUp: false,
      };
    });
}

async function billDrafts(v: Viewer): Promise<Draft[]> {
  if (!v.parent) return [];
  const f = await billsDue(v, 7);
  return f.data.map((b) => ({
    key: `bill:${b.name}:${b.date}`,
    category: 'bills' as const,
    text: `${b.name} $${b.amount.toFixed(2)} — due ${b.date === today() ? 'today' : shortDay(b.date)}${b.autopay ? ' (autopay)' : ''}`,
    subjectId: null,
    source: f.source,
    asOf: f.asOf,
    check: null,
    headsUp: !b.autopay,
  }));
}

/** What changed in the last 7 days (counts from the family's own records). */
async function changeDrafts(v: Viewer): Promise<Draft[]> {
  const t = today();
  const since = addDays(t, -7);
  const people = v.parent ? await listMembers() : [v.me];
  const out: Draft[] = [];
  const now = new Date().toISOString();
  const { rows: ev } = await pool.query<{ n: number }>(
    v.parent
      ? 'SELECT count(*)::int AS n FROM calendar_events WHERE created_at >= $1::date'
      : `SELECT count(*)::int AS n FROM calendar_events e WHERE e.created_at >= $1::date AND NOT e.adults_only
           AND (NOT EXISTS (SELECT 1 FROM calendar_event_people p WHERE p.event_id = e.id) OR EXISTS (SELECT 1 FROM calendar_event_people p WHERE p.event_id = e.id AND p.member_id = $2))`,
    v.parent ? [since] : [since, v.me.id],
  );
  if (ev[0]?.n) out.push({ key: `change:events:${t}`, category: 'change', text: `${ev[0].n} new thing${ev[0].n === 1 ? '' : 's'} went on the calendar.`, subjectId: null, source: SOURCE.calendar, asOf: now, check: null, headsUp: false });
  for (const m of people) {
    if (m.kind !== 'kid' && v.parent) continue;
    const { rows } = await pool.query<{ done: number; ontime: number; chores: number; points: number }>(
      `SELECT (SELECT count(*)::int FROM homework WHERE member_id = $1 AND done AND done_on > $2) AS done,
              (SELECT count(*)::int FROM homework WHERE member_id = $1 AND done AND done_on > $2 AND (due IS NULL OR done_on <= due)) AS ontime,
              (SELECT count(*)::int FROM chore_completions cc JOIN chores c ON c.id = cc.chore_id WHERE c.member_id = $1 AND cc.completed_on > $2) AS chores,
              (SELECT COALESCE(SUM(points), 0)::int FROM scores WHERE member_id = $1 AND earned_on > $2) AS points`,
      [m.id, since],
    );
    const r = rows[0];
    if (!r || (!r.done && !r.chores && !r.points)) continue;
    const who = v.parent ? `${m.name}: ` : 'This week you ';
    const parts = v.parent
      ? [`${r.done} homework done${r.done ? ` (${r.ontime} on time)` : ''}`, `${r.chores} chores`, `${r.points} points earned`]
      : [`finished ${r.done} homework${r.done === 1 ? '' : ' assignments'}`, `did ${r.chores} chores`, `earned ${r.points} points`];
    out.push({ key: `change:${m.id}:${t}`, category: 'change', text: `${who}${parts.join(', ')}.`, subjectId: m.id, source: SOURCE.chores, asOf: now, check: null, headsUp: false });
  }
  return out;
}

const SURFACE: Record<BriefKind, string> = { morning: 'brief_morning', evening: 'brief_evening', weekly: 'brief_weekly' };

/** Log every item shown (H9): one row per person, item and day; returns ids and any outcome already given. */
async function logItems(v: Viewer, kind: BriefKind, drafts: Draft[]): Promise<BriefItem[]> {
  const out: BriefItem[] = [];
  const day = today();
  for (const d of drafts) {
    const { rows } = await pool.query<{ id: number; outcome: ItemOutcome | null }>(
      `INSERT INTO hana_items (member_id, surface, category, item_key, subject_member_id, text, source, as_of, shown_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (member_id, surface, item_key, shown_on) DO UPDATE SET text = EXCLUDED.text, as_of = EXCLUDED.as_of
       RETURNING id, outcome`,
      [v.me.id, SURFACE[kind], d.category, d.key, d.subjectId, d.text, d.source, d.asOf, day],
    );
    const row = rows[0];
    if (row) out.push({ ...d, id: row.id, outcome: row.outcome });
  }
  return out;
}

/** The brief for this person: built from the tools, logged, returned. */
/** C4: loops about to break (past their date, today, tomorrow) — the brief leads with these. */
async function loopDrafts(v: Viewer, within: Array<'past' | 'today' | 'tomorrow'>): Promise<Draft[]> {
  const loops = (await loopsFor(v)).filter((l) => l.breaking && within.includes(l.breaking) && (v.parent || l.mine));
  return loops.map((l) => ({
    key: `loop:${l.id}`,
    category: 'loop' as const,
    text: loopLine(l, !v.parent),
    subjectId: null,
    source: SOURCE.loops,
    asOf: new Date().toISOString(),
    check: l.source === 'email' ? 'Read from forwarded mail' : null,
    headsUp: true,
  }));
}

/** C1: the last day's mail, triaged — school, medical, money and logistics first; never the noise. Parents only. */
async function mailDrafts(): Promise<Draft[]> {
  const { rows } = await pool.query<{ id: number; class: string; summary_enc: Buffer; key_id: string; received_at: Date }>(
    "SELECT id, class, summary_enc, key_id, received_at FROM inbox_emails WHERE summary_enc IS NOT NULL AND class <> 'noise' AND received_at > $1 ORDER BY array_position(ARRAY['school','medical','money','logistics','people'], class), received_at DESC LIMIT 6",
    [new Date(Date.now() - 86_400_000)],
  );
  return rows.map((r) => ({
    key: `mail:${r.id}`,
    category: 'mail' as const,
    text: `${r.class.charAt(0).toUpperCase()}${r.class.slice(1)} — ${openText(r.summary_enc, r.key_id)}`,
    subjectId: null,
    source: SOURCE.inbox,
    asOf: r.received_at.toISOString(),
    check: null,
    headsUp: r.class !== 'people',
  }));
}

export async function briefFor(v: Viewer, kind: BriefKind): Promise<Brief> {
  const t = today();
  const sections: Array<{ title: string; drafts: Draft[] }> = [];
  if (kind === 'morning') {
    const cal = await scheduleFor(v, t, t);
    const s = scheduleDrafts(v, cal, t, 'today', await conflictOptions(dayName));
    sections.push({ title: v.parent ? 'About to break' : 'Things you said you’d do', drafts: await loopDrafts(v, ['past', 'today', 'tomorrow']) });
    sections.push({ title: v.parent ? 'Today, person by person' : 'Your day', drafts: s.schedule });
    sections.push({ title: v.parent ? 'Pickups & handoffs' : 'Rides', drafts: s.pickups });
    sections.push({ title: v.parent ? 'Needs a decision' : 'Heads up', drafts: s.conflicts });
    sections.push({ title: v.parent ? 'Homework due today & tomorrow' : 'Homework', drafts: await homeworkDrafts(v, t, addDays(t, 1)) });
    if (v.parent) {
      sections.push({
        title: 'Money',
        drafts: (await moneyBrief()).map((x) => ({ key: x.key, category: 'money' as const, text: x.text, subjectId: null, source: SOURCE.money, asOf: x.asOf, check: x.check, headsUp: x.headsUp })),
      });
    }
    if (v.parent) sections.push({ title: 'Bills due this week', drafts: await billDrafts(v) });
    if (v.parent) sections.push({ title: 'From the inbox', drafts: await mailDrafts() });
    if (v.parent) {
      sections.push({
        title: 'Expiring soon',
        drafts: (await listVault())
          .filter((x) => x.expiring)
          .map((x) => ({ key: `expiry:${x.id}`, category: 'expiry' as const, text: expiryLine(x), subjectId: null, source: SOURCE.papers, asOf: new Date().toISOString(), check: null, headsUp: (x.daysLeft ?? 0) <= 30 })),
      });
    }
    sections.push({ title: v.parent ? 'Chores & points' : 'Chores & points', drafts: await choreDrafts(v, t) });
  } else if (kind === 'evening') {
    const tm = addDays(t, 1);
    const cal = await scheduleFor(v, tm, tm);
    const s = scheduleDrafts(v, cal, tm, 'tomorrow', await conflictOptions(dayName));
    const unowned = s.pickups.filter((p) => p.headsUp);
    sections.push({ title: v.parent ? 'Loops due tomorrow' : 'Due tomorrow from you', drafts: await loopDrafts(v, ['tomorrow']) });
    sections.push({ title: v.parent ? 'Nobody’s on these yet' : 'Rides to sort out', drafts: v.parent ? [...unowned, ...s.conflicts] : unowned });
    sections.push({ title: 'Tomorrow', drafts: [...s.schedule, ...s.pickups.filter((p) => !p.headsUp)] });
    sections.push({ title: 'Due tomorrow', drafts: await homeworkDrafts(v, tm, tm) });
  } else {
    sections.push({ title: v.parent ? 'What changed in the family this week' : 'Your week', drafts: await changeDrafts(v) });
    const nextWeek = await scheduleFor(v, addDays(t, 1), addDays(t, 7));
    const ahead = nextWeek.data.length;
    sections.push({
      title: 'The week ahead',
      drafts: [
        {
          key: `ahead:${t}`,
          category: 'schedule',
          text: ahead ? `${ahead} thing${ahead === 1 ? '' : 's'} on the calendar in the next 7 days${nextWeek.data.some((e) => e.pickup && !e.pickupBy) && v.parent ? `, including ${nextWeek.data.filter((e) => e.pickup && !e.pickupBy).length} pickup(s) nobody is on yet` : ''}.` : 'Nothing on the calendar in the next 7 days yet.',
          subjectId: null,
          source: nextWeek.source,
          asOf: nextWeek.asOf,
          check: nextWeek.stale,
          headsUp: v.parent && nextWeek.data.some((e) => e.pickup && !e.pickupBy),
        },
        ...(await homeworkDrafts(v, addDays(t, 1), addDays(t, 7))),
      ],
    });
  }
  const out: Brief['sections'] = [];
  for (const s of sections) if (s.drafts.length) out.push({ title: s.title, items: await logItems(v, kind, s.drafts) });
  await logEvent('hana_brief', { kind, view: v.parent ? 'parent' : 'child', items: out.reduce((n, s) => n + s.items.length, 0) }, v.me.id);
  const hour = Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: config.tz }));
  const hi = kind === 'evening' ? 'Good evening' : kind === 'weekly' ? 'Here’s your week' : hour < 12 ? 'Good morning' : 'Hi';
  return {
    kind,
    date: t,
    view: v.parent ? 'parent' : 'child',
    greeting: young(v) ? `${hi}, ${v.me.name}! Here’s your day.` : `${hi}, ${v.me.name}.`,
    sections: out,
  };
}

/** Mark an item: acted on, not now, or wrong (H9). Only your own items. */
export async function markItem(v: Viewer, id: number, outcome: ItemOutcome): Promise<boolean> {
  const { rowCount } = await pool.query('UPDATE hana_items SET outcome = $3, outcome_at = now() WHERE id = $1 AND member_id = $2', [id, v.me.id, outcome]);
  if (rowCount) await logEvent('hana_item_outcome', { outcome }, v.me.id);
  return !!rowCount;
}

