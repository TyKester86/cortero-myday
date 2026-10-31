/**
 * H2 — Hana's toolbelt: typed, READ-ONLY reads over the household's live data.
 * Nothing here writes app state. Each read takes a Viewer and applies household
 * scope (row-level security) and role scope (parent vs child) in the query itself,
 * and every result carries its source and as-of time (facts.ts).
 */
import type { DateStr, HouseholdMember } from '@myday/shared';
import { pool } from '../../db.js';
import { addDays, today } from '../dates.js';
import { inbox } from '../feednotify.js';
import { listMembers } from '../members.js';
import { occurrences } from '../../routes/calendar.js';
import { billsFor } from '../../routes/bills.js';
import { bankFor } from '../../routes/rewards.js';
import { plannedSession, profileFor } from '../../routes/health.js';
import { fact, SOURCE, untrusted, type Fact } from './facts.js';
import { requireParent, scopedMember, visibleMembers, type Viewer } from './scope.js';

const fmtDay = (d: DateStr): string => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

/* ---------- schedule (calendar) ---------- */

export interface ScheduleItem {
  eventId: number;
  date: DateStr;
  time: string | null;
  endTime: string | null;
  title: string;
  location: string;
  /** Who it's for (names); empty = everyone. */
  people: string[];
  adultsOnly: boolean;
  pickup: boolean;
  pickupBy: string | null;
  /** Where it comes from: MyDay's own calendar, or someone's connected calendar (labeled, never merged). */
  from: string;
  /** Someone's connected calendar shared as busy-only: the time is real, the title isn't shown. */
  busy: boolean;
}

/** The calendar between two days. A child gets only events for them (or for everyone), never grown-ups-only ones. */
export async function scheduleFor(v: Viewer, from: DateStr, to: DateStr): Promise<Fact<ScheduleItem[]>> {
  const members = await listMembers();
  const occ = await occurrences(from, to, !v.parent, members);
  const mine = v.parent ? occ : occ.filter((o) => !o.adultsOnly && (!o.people.length || o.people.some((p) => p.id === v.me.id)));
  const { rows } = await pool.query<{ at: Date | null }>('SELECT max(updated_at) AS at FROM calendar_events');
  const items: ScheduleItem[] = mine.map((o) => ({
    eventId: o.eventId,
    date: o.date,
    time: o.startTime,
    endTime: o.endTime,
    title: o.title,
    location: o.location,
    people: o.people.map((p) => p.name),
    adultsOnly: o.adultsOnly,
    pickup: o.pickup,
    pickupBy: o.pickupBy?.name ?? null,
    from: SOURCE.calendar,
    busy: false,
  }));
  // C2: connected calendars. A parent sees everyone's (others' busy-only ones as "Busy"); a child only their own.
  const conn = await connectedFor(v, from, to, members);
  if (!conn.sources.length) return fact(items, SOURCE.calendar, rows[0]?.at ?? new Date());
  items.push(...conn.items);
  items.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.eventId - b.eventId);
  const oldest = conn.sources.reduce<Date | null>((o, s) => (!s.synced ? o : !o || s.synced < o ? s.synced : o), null);
  const behind = conn.sources.filter((s) => s.error || !s.synced || Date.now() - s.synced.getTime() > 3 * 3_600_000);
  return fact(
    items,
    SOURCE.timeline,
    oldest ?? rows[0]?.at ?? new Date(),
    behind.length ? `${behind.map((s) => s.label).join(', ')} ${behind.length === 1 ? 'hasn’t' : 'haven’t'} been read recently — times there may have changed` : null,
  );
}

async function connectedFor(
  v: Viewer,
  from: DateStr,
  to: DateStr,
  members: HouseholdMember[],
): Promise<{ items: ScheduleItem[]; sources: Array<{ label: string; synced: Date | null; error: string | null }> }> {
  const { rows: src } = await pool.query<{ id: number; member_id: number; label: string; visibility: 'busy' | 'details'; last_synced_at: Date | null; last_error: string | null }>(
    'SELECT id, member_id, label, visibility, last_synced_at, last_error FROM calendar_sources' + (v.parent ? '' : ' WHERE member_id = $1'),
    v.parent ? [] : [v.me.id],
  );
  if (!src.length) return { items: [], sources: [] };
  const byId = new Map(members.map((m) => [m.id, m]));
  const bySrc = new Map(src.map((s) => [s.id, s]));
  const { rows } = await pool.query<{ id: number; source_id: number; starts_on: DateStr; start_time: string | null; end_time: string | null; title: string; location: string }>(
    `SELECT id, source_id, starts_on::text AS starts_on, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time, title, location
       FROM calendar_source_events WHERE source_id = ANY($1::int[]) AND starts_on BETWEEN $2 AND $3`,
    [src.map((s) => s.id), from, to],
  );
  const items = rows.flatMap((r): ScheduleItem[] => {
    const s = bySrc.get(r.source_id);
    const owner = s ? byId.get(s.member_id) : undefined;
    if (!s || !owner) return [];
    const busy = s.visibility === 'busy' && owner.id !== v.me.id;
    return [
      {
        eventId: -r.id,
        date: r.starts_on,
        time: r.start_time,
        endTime: r.end_time,
        title: busy ? 'Busy' : r.title,
        location: r.location,
        people: [owner.name],
        adultsOnly: false,
        pickup: false,
        pickupBy: null,
        from: `${owner.name}’s ${s.label}`,
        busy,
      },
    ];
  });
  return { items, sources: src.map((s) => ({ label: `${byId.get(s.member_id)?.name ?? 'Someone'}’s ${s.label}`, synced: s.last_synced_at, error: s.last_error })) };
}

/* ---------- homework ---------- */

export interface HomeworkItem {
  id: number;
  memberId: number;
  member: string;
  assignment: string;
  subject: string;
  due: DateStr | null;
  done: boolean;
  doneOn: DateStr | null;
  source: 'manual' | 'lecture' | 'classroom' | 'email';
  /** The source now says something different from this list (said, never silently resolved). */
  conflict: string | null;
}

const SOURCE_LABEL = { manual: 'typed in', lecture: 'the lecture notes', classroom: 'Google Classroom', email: 'the school email' } as const;

/** Open homework (and anything finished in the last 14 days). A child gets only their own. */
export async function homeworkFor(v: Viewer, who?: string | null, members?: HouseholdMember[]): Promise<Fact<HomeworkItem[]>> {
  const people = members ?? (await scopedMember(v, who));
  const byId = new Map(people.map((m) => [m.id, m]));
  const { rows } = await pool.query<{
    id: number;
    member_id: number;
    assignment: string;
    subject: string;
    due: DateStr | null;
    done: boolean;
    done_on: DateStr | null;
    source: HomeworkItem['source'];
    source_due: DateStr | null;
    has_source: boolean;
    created_at: Date;
  }>(
    `SELECT h.id, h.member_id, h.assignment, h.subject, h.due::text AS due, h.done, h.done_on::text AS done_on, h.source,
            la.due::text AS source_due, (la.id IS NOT NULL) AS has_source, h.created_at
       FROM homework h
       LEFT JOIN lecture_assignments la ON h.source = 'lecture' AND la.id = h.source_ref
      WHERE h.member_id = ANY($1::int[]) AND (NOT h.done OR h.done_on >= $2)
      ORDER BY h.due NULLS LAST, h.id`,
    [people.map((m) => m.id), addDays(today(), -14)],
  );
  const items = rows.map((r): HomeworkItem => {
    const changed = r.has_source && (r.source_due ?? '') !== (r.due ?? '');
    return {
      id: r.id,
      memberId: r.member_id,
      member: byId.get(r.member_id)?.name ?? '',
      assignment: r.assignment,
      subject: r.subject,
      due: r.due,
      done: r.done,
      doneOn: r.done_on,
      source: r.source,
      conflict: changed
        ? `${SOURCE_LABEL[r.source]} now say${r.source === 'lecture' ? '' : 's'} ${r.source_due ? `due ${fmtDay(r.source_due)}` : 'no due date'}, but this list says ${r.due ? `due ${fmtDay(r.due)}` : 'no due date'} — check which is right`
        : null,
    };
  });
  const conflicts = items.filter((i) => i.conflict).length;
  const newest = rows.reduce<Date | null>((m, r) => (!m || r.created_at > m ? r.created_at : m), null);
  return fact(items, SOURCE.homework, newest ?? new Date(), conflicts ? `${conflicts} due date${conflicts === 1 ? '' : 's'} changed at the source after capture` : null);
}

/* ---------- chores, points, rewards ---------- */

export interface ChoreDay {
  memberId: number;
  member: string;
  chores: Array<{ name: string; done: boolean }>;
  points: number;
  /** The nearest reward: ready now, or how many points short. */
  reward: { name: string; cost: number; short: number } | null;
}

export async function choresFor(v: Viewer, day: DateStr = today(), who?: string | null): Promise<Fact<ChoreDay[]>> {
  const people = await scopedMember(v, who);
  const iso = new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
  const out: ChoreDay[] = [];
  for (const m of people) {
    const { rows: chores } = await pool.query<{ name: string; done: boolean }>(
      `SELECT c.name, EXISTS (SELECT 1 FROM chore_completions cc WHERE cc.chore_id = c.id AND cc.completed_on = $3) AS done
         FROM chores c WHERE c.member_id = $1 AND c.active AND $2 = ANY(c.days) ORDER BY c.id`,
      [m.id, iso, day],
    );
    const points = await bankFor(m.id);
    let reward: ChoreDay['reward'] = null;
    if (m.kind === 'kid') {
      const { rows: rw } = await pool.query<{ name: string; cost: number }>('SELECT name, cost FROM rewards WHERE member_id IS NULL OR member_id = $1 ORDER BY cost, id', [m.id]);
      const next = rw.find((r) => r.cost > points) ?? rw[rw.length - 1];
      if (next) reward = { name: next.name, cost: next.cost, short: Math.max(0, next.cost - points) };
    }
    if (chores.length || m.kind === 'kid') out.push({ memberId: m.id, member: m.name, chores, points, reward });
  }
  return fact(out, SOURCE.chores, new Date());
}

/* ---------- money (parents only) ---------- */

export interface BillDue {
  name: string;
  amount: number;
  date: DateStr;
  autopay: boolean;
}

/** Bills on this parent's own list due in the next `days` days (max 7). A child never gets money data. */
export async function billsDue(v: Viewer, days = 7): Promise<Fact<BillDue[]>> {
  requireParent(v, 'Money');
  const b = await billsFor(v.me.id);
  const until = addDays(today(), Math.min(7, Math.max(0, days)));
  const auto = new Map(b.bills.map((x) => [x.name, x.autopay]));
  return fact(
    b.dueSoon.filter((d) => d.date <= until).map((d) => ({ name: d.name, amount: d.amount, date: d.date, autopay: auto.get(d.name) ?? false })),
    SOURCE.bills,
    new Date(),
  );
}

export interface Balance {
  accounts: Array<{ name: string; available: number | null }>;
  /** Spendable cash across the household's linked checking/savings, or null with none linked. */
  total: number | null;
}

/** Linked bank balances (household accounts). Older than a day and a half = said as possibly out of date. */
export async function balances(v: Viewer): Promise<Fact<Balance>> {
  requireParent(v, 'Money');
  const { rows } = await pool.query<{ name: string; available: string | null; current: string | null; updated_at: Date }>(
    `SELECT a.name, a.available, a.current, a.updated_at FROM money_accounts a JOIN money_items i ON i.id = a.item_id
      WHERE i.member_id IS NULL AND a.type = 'depository' ORDER BY a.id`,
  );
  if (!rows.length) return fact({ accounts: [], total: null }, SOURCE.bank, new Date(), 'no bank account is linked, so there is no balance to show');
  const accounts = rows.map((r) => ({ name: r.name, available: r.available !== null ? Number(r.available) : r.current !== null ? Number(r.current) : null }));
  const oldest = rows.reduce((m, r) => (r.updated_at < m ? r.updated_at : m), rows[0]?.updated_at ?? new Date());
  const hours = (Date.now() - oldest.getTime()) / 3_600_000;
  return fact(
    { accounts, total: Math.round(accounts.reduce((s, a) => s + (a.available ?? 0), 0) * 100) / 100 },
    SOURCE.bank,
    oldest,
    hours > 36 ? `the bank last synced ${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? '' : 's'} ago` : null,
  );
}

/* ---------- the Feed (grown-ups only; outside content) ---------- */

/** The parent's recent Feed notifications, fenced as outside content (data, never instructions). */
export async function feedInbox(v: Viewer, limit = 10): Promise<Fact<string>> {
  requireParent(v, 'The Feed');
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM users WHERE member_id = $1 ORDER BY last_login_at DESC LIMIT 1', [v.me.id]);
  const uid = rows[0]?.id;
  if (!uid) return fact('', SOURCE.feed, new Date(), 'no Feed account is linked to this person');
  const box = await inbox(uid, limit);
  const lines = box.items.map((i) => `- ${i.text}`);
  return fact(lines.length ? untrusted('The Feed', lines.join('\n')) : '', SOURCE.feed, new Date());
}

/* ---------- health: organization only (schedules the family entered), never interpretation ---------- */

export interface HealthDay {
  member: string;
  workoutToday: string | null;
  appointments: Array<{ date: DateStr; time: string | null; title: string }>;
}

const APPT = /\b(doctor|dr\.?|dentist|dental|clinic|appointment|appt|pediatric\w*|therap\w*|orthodont\w*|check-?up|vaccin\w*|physical|optometr\w*|eye exam|pharmacy|refill)\b/i;

export async function healthFor(v: Viewer, who?: string | null): Promise<Fact<HealthDay[]>> {
  const people = await scopedMember(v, who);
  const t = today();
  const cal = await scheduleFor(v, t, addDays(t, 14));
  const out: HealthDay[] = [];
  for (const m of people) {
    const prof = await profileFor(m.id);
    const session = prof ? (await plannedSession(m.id, prof, t)).session : null;
    out.push({
      member: m.name,
      workoutToday: session ? session.dayName : null,
      appointments: cal.data.filter((e) => APPT.test(e.title) && (!e.people.length || e.people.includes(m.name))).map((e) => ({ date: e.date, time: e.time, title: e.title })),
    });
  }
  return fact(out, SOURCE.health, new Date());
}

/* ---------- the household ---------- */

export async function familyFor(v: Viewer): Promise<Fact<Array<{ name: string; kind: 'adult' | 'kid'; age: number | null }>>> {
  const people = await visibleMembers(v);
  return fact(people.map((m) => ({ name: m.name, kind: m.kind, age: m.age })), SOURCE.family, new Date());
}
