/**
 * Q8, C7: health logistics — organization only (migrations/062_health_logistics.sql). H8's rail is
 * unchanged: she never interprets, diagnoses or advises. Every pack ends with the same line.
 *
 *  - Medications as the family entered them. With the supply on hand and how many a day, a
 *    prescription running low becomes a loop (C4) days before it runs out — and a refill a parent
 *    logs is the evidence that closes it. Without that data she says so, and doesn't guess.
 *  - Recurring care (the dentist every 6 months): when one comes due and nothing matching is on
 *    the calendar, booking it is a loop; the booked appointment (or a logged visit) closes it.
 *  - Prep packs, the night before, per person: the visit, the records the family entered, and the
 *    questions they listed. A grown-up's pack carries meds and papers; a kid's, their visit and
 *    their own questions. Medication and care records are for the grown-ups.
 */
import type { CareItem, DateStr, HouseholdMember, Medication, PrepPack, VisitQuestion } from '@myday/shared';
import { pool } from '../../db.js';
import { addDays, today } from '../dates.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';
import { dayLabel } from '../money/mind.js';
import { listVault } from './papers.js';
import { openLoop } from './loops.js';
import { viewerOf, type Viewer } from './scope.js';
import { APPT, scheduleFor } from './tools.js';

export const CLINICIAN_LINE = 'Here’s what your records show; a clinician is the right call for anything medical.';
export const HEALTH_SOURCE = 'Your medications, care schedule & calendar';
const LOW_DAYS = 7;
const CARE_AHEAD = 30;

const daysBetween = (a: DateStr, b: DateStr): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const addMonths = (d: DateStr, n: number): DateStr => {
  const x = new Date(`${d}T12:00:00Z`);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x.toISOString().slice(0, 10) as DateStr;
};
const possessive = (name: string): string => `${name}’${name.endsWith('s') ? '' : 's'}`;

export const requireParentHealth = (me: HouseholdMember): void => {
  if (me.kind !== 'adult') throw new HttpError(403, 'Medications and care records are for grown-ups');
};

/* ---------- medications ---------- */

interface MedRow {
  id: number;
  member_id: number;
  name: string;
  dose: string;
  schedule: string;
  per_day: string | null;
  supply: string | null;
  supply_on: DateStr | null;
  refills_left: number | null;
  pharmacy: string;
  prescriber: string;
  active: boolean;
}
const MED_COLS = 'id, member_id, name, dose, schedule, per_day, supply, supply_on::text AS supply_on, refills_left, pharmacy, prescriber, active';

function toMed(r: MedRow, names: Map<number, string>, t: DateStr): Medication {
  const perDay = r.per_day === null ? null : Number(r.per_day);
  const supply = r.supply === null ? null : Number(r.supply);
  let left: number | null = null;
  let runsOut: DateStr | null = null;
  let daysLeft: number | null = null;
  if (perDay && supply !== null && r.supply_on) {
    runsOut = addDays(r.supply_on, Math.floor(supply / perDay)) as DateStr;
    left = Math.max(0, Math.round((supply - perDay * Math.max(0, daysBetween(r.supply_on, t))) * 100) / 100);
    daysLeft = Math.max(0, daysBetween(t, runsOut));
  }
  const low = r.active && daysLeft !== null && daysLeft <= LOW_DAYS;
  const refills = r.refills_left === null ? '' : r.refills_left === 0 ? ' No refills left — the prescriber needs to send a new prescription.' : ` ${r.refills_left} refill${r.refills_left === 1 ? '' : 's'} left.`;
  const status = !r.active
    ? 'Not tracking (stopped).'
    : daysLeft === null
      ? 'Add the supply on hand and how many a day, and she’ll watch for the refill.'
      : `${daysLeft === 0 ? 'Runs out today' : `About ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`} (runs out about ${dayLabel(runsOut as DateStr)}).${refills}`;
  return {
    id: r.id,
    memberId: r.member_id,
    member: names.get(r.member_id) ?? '?',
    name: r.name,
    dose: r.dose,
    schedule: r.schedule,
    perDay,
    supply,
    supplyOn: r.supply_on,
    refillsLeft: r.refills_left,
    pharmacy: r.pharmacy,
    prescriber: r.prescriber,
    active: r.active,
    left,
    runsOut,
    daysLeft,
    low,
    status,
  };
}

const names = async (): Promise<Map<number, string>> => new Map((await listMembers()).map((m) => [m.id, m.name]));

export async function listMeds(): Promise<Medication[]> {
  const { rows } = await pool.query<MedRow>(`SELECT ${MED_COLS} FROM medications ORDER BY active DESC, member_id, name`);
  const n = await names();
  const t = today();
  return rows.map((r) => toMed(r, n, t));
}

async function medById(id: number): Promise<Medication> {
  const m = (await listMeds()).find((x) => x.id === id);
  if (!m) throw new HttpError(404, 'No such medication');
  return m;
}

/** Find one by name ("Evan’s albuterol", "albuterol") — for Hana's tools. */
export async function medByName(text: string): Promise<Medication> {
  const q = text.trim().toLowerCase();
  const meds = (await listMeds()).filter((m) => m.active);
  const hit = meds.filter((m) => q.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(q.replace(/^\w+[’']s /, '')));
  const who = hit.filter((m) => q.includes(m.member.toLowerCase()));
  const pick = who.length ? who : hit;
  if (pick.length !== 1) throw new HttpError(pick.length ? 409 : 404, pick.length ? `Which one — ${pick.map((m) => `${possessive(m.member)} ${m.name}`).join(' or ')}?` : `There’s no medication called “${text}” on the list`);
  return pick[0] as Medication;
}

const refillLine = (m: Medication): string =>
  m.refillsLeft === 0
    ? `Ask ${m.prescriber || 'the prescriber'} for a new prescription for ${possessive(m.member)} ${m.name} — no refills left, ${m.daysLeft === 0 ? 'runs out today' : `about ${m.daysLeft} day${m.daysLeft === 1 ? '' : 's'} of supply`}`
    : `Refill ${possessive(m.member)} ${m.name} — ${m.daysLeft === 0 ? 'runs out today' : `about ${m.daysLeft} day${m.daysLeft === 1 ? '' : 's'} left (runs out about ${dayLabel(m.runsOut as DateStr)})`}${m.pharmacy ? `; ${m.pharmacy}` : ''}`;

/** A parent logs a refill: the supply restarts from what's left plus what came home. That is the evidence. */
export async function logRefill(me: HouseholdMember, id: number, amount: number): Promise<Medication> {
  requireParentHealth(me);
  if (!(amount > 0) || amount > 10_000) throw new HttpError(400, 'How many came home?');
  const m = await medById(id);
  const t = today();
  await pool.query('INSERT INTO med_refills (med_id, on_date, amount, logged_by) VALUES ($1, $2, $3, $4)', [id, t, amount, me.id]);
  await pool.query(
    'UPDATE medications SET supply = $2, supply_on = $3, refills_left = CASE WHEN refills_left > 0 THEN refills_left - 1 ELSE refills_left END WHERE id = $1',
    [id, (m.left ?? 0) + amount, t],
  );
  await healthLoops();
  return medById(id);
}

/* ---------- recurring care ---------- */

interface CareRow {
  id: number;
  member_id: number;
  what: string;
  every_months: number;
  last_on: DateStr | null;
}
const STOP = new Set(['the', 'and', 'with', 'for', 'visit', 'appointment', 'yearly', 'annual', 'check', 'every']);
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP.has(w));

export async function careItems(): Promise<CareItem[]> {
  const { rows } = await pool.query<CareRow>('SELECT id, member_id, what, every_months, last_on::text AS last_on FROM care_schedule ORDER BY member_id, what');
  if (!rows.length) return [];
  const members = await listMembers();
  const n = new Map(members.map((m) => [m.id, m.name]));
  const parent = members.find((m) => m.kind === 'adult');
  const t = today();
  const cal = parent ? (await scheduleFor(viewerOf(parent), t, addDays(t, 400) as DateStr)).data.filter((e) => !e.busy) : [];
  return rows.map((r) => {
    const member = n.get(r.member_id) ?? '?';
    const dueOn = r.last_on ? addMonths(r.last_on, r.every_months) : null;
    const w = words(r.what);
    const hit = cal.find((e) => (!e.people.length || e.people.includes(member)) && w.some((x) => e.title.toLowerCase().includes(x)) && (!dueOn || e.date <= addDays(dueOn, 90)));
    const booked = hit ? { date: hit.date, title: hit.title } : null;
    const every = `every ${r.every_months} month${r.every_months === 1 ? '' : 's'}`;
    const status = booked
      ? `Booked: ${booked.title} on ${dayLabel(booked.date)}.`
      : !dueOn
        ? `${every}. Add when the last one was, and she’ll watch for the next.`
        : `Due by ${dayLabel(dueOn)} (${every}; last ${dayLabel(r.last_on as DateStr)}).${daysBetween(t, dueOn) <= CARE_AHEAD ? ' Not booked yet.' : ''}`;
    return { id: r.id, memberId: r.member_id, member, what: r.what, everyMonths: r.every_months, lastOn: r.last_on, dueOn, booked, status };
  });
}

/* ---------- loops: opened from the data, closed on evidence ---------- */

async function closeLoops(prefix: string, keep: string, evidence: string): Promise<void> {
  await pool.query("UPDATE open_loops SET closed_at = $1, closed_evidence = $2 WHERE source = 'health' AND source_ref LIKE $3 AND source_ref <> $4 AND closed_at IS NULL", [
    new Date(),
    evidence,
    `${prefix}%`,
    keep,
  ]);
}

export async function healthLoops(): Promise<void> {
  const t = today();
  for (const m of await listMeds()) {
    const ref = m.low ? `health:refill:${m.id}:${m.runsOut}` : '';
    const { rows: last } = await pool.query<{ on_date: DateStr; amount: string; name: string | null }>(
      'SELECT r.on_date::text AS on_date, r.amount, hm.name FROM med_refills r LEFT JOIN household_members hm ON hm.id = r.logged_by WHERE r.med_id = $1 ORDER BY r.id DESC LIMIT 1',
      [m.id],
    );
    const r = last[0];
    const evidence = !m.active ? 'Stopped tracking this medication' : r ? `A refill of ${Number(r.amount)} was logged by ${r.name ?? 'a parent'} on ${dayLabel(r.on_date)}` : 'The supply on record covers it now';
    await closeLoops(`health:refill:${m.id}:`, ref, evidence);
    if (ref) await openLoop(null, { what: refillLine(m), owedBy: 'the family', due: (m.runsOut && addDays(m.runsOut, -2) > t ? addDays(m.runsOut, -2) : t) as DateStr, source: 'health', sourceRef: ref });
  }
  for (const c of await careItems()) {
    const due = !c.booked && c.dueOn && daysBetween(t, c.dueOn) <= CARE_AHEAD;
    const ref = due ? `health:care:${c.id}:${c.dueOn}` : '';
    await closeLoops(`health:care:${c.id}:`, ref, c.booked ? `Booked: ${c.booked.title} on ${dayLabel(c.booked.date)}` : c.lastOn ? `Visit logged on ${dayLabel(c.lastOn)}` : 'No longer due');
    if (due) {
      await openLoop(null, {
        what: `Book ${possessive(c.member)} ${c.what} — due by ${dayLabel(c.dueOn as DateStr)} (every ${c.everyMonths} month${c.everyMonths === 1 ? '' : 's'}; last ${dayLabel(c.lastOn as DateStr)})`,
        owedBy: 'the family',
        due: (c.dueOn as DateStr) < t ? t : (c.dueOn as DateStr),
        source: 'health',
        sourceRef: ref,
      });
    }
  }
}

/** The watch: loops from the data, and each low supply or due visit said once. Parents only. */
export async function healthWatch(parents: HouseholdMember[]): Promise<Array<{ key: string; category: 'health'; text: string; sameDay: boolean; subjectId: null; source: string; asOf: string; once: true }>> {
  if (!parents.length) return [];
  await healthLoops();
  const asOf = new Date().toISOString();
  const base = { category: 'health' as const, sameDay: false, subjectId: null, source: HEALTH_SOURCE, asOf, once: true as const };
  const t = today();
  return [
    ...(await listMeds()).filter((m) => m.low).map((m) => ({ ...base, key: `health:refill:${m.id}:${m.runsOut}`, text: `${refillLine(m)}.` })),
    ...(await careItems())
      .filter((c) => !c.booked && c.dueOn && daysBetween(t, c.dueOn) <= CARE_AHEAD)
      .map((c) => ({ ...base, key: `health:care:${c.id}:${c.dueOn}`, text: `${possessive(c.member)} ${c.what} is due by ${dayLabel(c.dueOn as DateStr)} and nothing is booked yet.` })),
  ];
}

/* ---------- visits: questions and the prep pack ---------- */

export const visitKey = (eventId: number, date: DateStr): string => `${eventId}:${date}`;

/** The visits (appointments on the calendar) a viewer may see on a day. */
async function visitsOn(v: Viewer, date: DateStr) {
  return (await scheduleFor(v, date, date)).data.filter((e) => !e.busy && APPT.test(e.title));
}

export async function addQuestion(me: HouseholdMember, key: string, memberName: string | null, question: string): Promise<VisitQuestion> {
  const q = question.trim().slice(0, 300);
  if (!q) throw new HttpError(400, 'What’s the question?');
  const m = key.match(/^(-?\d+):(\d{4}-\d{2}-\d{2})$/);
  if (!m) throw new HttpError(400, 'Which visit?');
  const date = m[2] as DateStr;
  const v = viewerOf(me);
  const visit = (await visitsOn(v, date)).find((e) => visitKey(e.eventId, e.date) === key);
  if (!visit) throw new HttpError(404, 'That visit isn’t on your calendar');
  const who = memberName ?? (visit.people.length === 1 ? visit.people[0] : me.kind === 'kid' ? me.name : null);
  if (!who || (visit.people.length && !visit.people.includes(who))) throw new HttpError(400, `Whose question is it? This visit is for ${visit.people.join(' and ') || 'the family'}`);
  // A kid adds questions only for their own visit.
  if (me.kind === 'kid' && who !== me.name) throw new HttpError(403, 'You can add questions for your own visits');
  const member = (await listMembers()).find((x) => x.name === who);
  if (!member) throw new HttpError(400, 'Who is the visit for?');
  const { rows } = await pool.query<{ id: number }>('INSERT INTO visit_questions (visit_key, on_date, member_id, question, added_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [key, date, member.id, q, me.id]);
  return { id: (rows[0] as { id: number }).id, question: q, addedBy: me.name };
}

export async function removeQuestion(me: HouseholdMember, id: number): Promise<void> {
  const { rowCount } = await pool.query(
    me.kind === 'adult' ? 'DELETE FROM visit_questions WHERE id = $1' : 'DELETE FROM visit_questions WHERE id = $1 AND member_id = $2',
    me.kind === 'adult' ? [id] : [id, me.id],
  );
  if (!rowCount) throw new HttpError(404, 'Not found');
}

/** The next visit for someone (Hana's "add a question for Evan's next appointment"). */
export async function nextVisitFor(me: HouseholdMember, memberName: string): Promise<{ key: string; title: string; date: DateStr }> {
  const t = today();
  const v = viewerOf(me);
  const hit = (await scheduleFor(v, t, addDays(t, 120) as DateStr)).data.find((e) => !e.busy && APPT.test(e.title) && e.people.includes(memberName));
  if (!hit) throw new HttpError(404, `There’s no appointment for ${memberName} on the calendar in the next four months`);
  return { key: visitKey(hit.eventId, hit.date), title: hit.title, date: hit.date };
}

/** Prep packs for a day's visits, per person. A kid gets their own visit and their own questions. */
export async function prepPacks(v: Viewer, date: DateStr): Promise<PrepPack[]> {
  const members = await listMembers();
  const asOf = new Date().toISOString();
  const meds = v.parent ? await listMeds() : [];
  const vault = v.parent ? await listVault() : [];
  const out: PrepPack[] = [];
  for (const e of await visitsOn(v, date)) {
    const key = visitKey(e.eventId, e.date);
    const people = e.people.length ? e.people : [null];
    for (const who of people) {
      if (!v.parent && who !== v.me.name && who !== null) continue;
      const member = who ? (members.find((m) => m.name === who) ?? null) : null;
      const { rows: qs } = member
        ? await pool.query<{ id: number; question: string; name: string | null }>(
            'SELECT q.id, q.question, hm.name FROM visit_questions q LEFT JOIN household_members hm ON hm.id = q.added_by WHERE q.visit_key = $1 AND q.member_id = $2 ORDER BY q.id',
            [key, member.id],
          )
        : { rows: [] };
      const records: PrepPack['records'] = [];
      if (v.parent && member) {
        const { rows: mem } = await pool.query<{ fact: string }>("SELECT fact FROM hana_memories WHERE shared AND kind = 'medical' AND about_member_id = $1 ORDER BY id", [member.id]);
        for (const r of mem) records.push({ what: r.fact, from: 'Family memory' });
        const { rows: docs } = await pool.query<{ title: string; needed: string; deadline: DateStr | null }>(
          "SELECT title, needed, deadline::text AS deadline FROM documents WHERE kind IN ('medical', 'insurance') AND done_at IS NULL AND (about_member = $1 OR about_member IS NULL) ORDER BY deadline NULLS LAST, id",
          [member.id],
        );
        for (const d of docs) records.push({ what: `${d.title}${d.needed ? ` — ${d.needed}` : ''}${d.deadline ? ` (due ${dayLabel(d.deadline)})` : ''}`, from: 'Papers' });
        for (const x of vault.filter((x) => x.kind === 'insurance_card' && (x.holder === null || x.holder === member.name))) {
          records.push({ what: `${x.label}${x.issuer ? ` (${x.issuer})` : ''}${x.masked ? ` ${x.masked}` : ''} — bring the card`, from: 'Vault' });
        }
      }
      out.push({
        visitKey: key,
        date: e.date,
        time: e.time,
        title: e.title,
        location: e.location,
        member: who ?? 'the family',
        memberId: member?.id ?? null,
        questions: qs.map((q) => ({ id: q.id, question: q.question, addedBy: q.name })),
        medications: member ? meds.filter((m) => m.active && m.memberId === member.id).map((m) => ({ name: m.name, dose: m.dose, schedule: m.schedule, status: m.status })) : [],
        records,
        rail: CLINICIAN_LINE,
        source: HEALTH_SOURCE,
        asOf,
      });
    }
  }
  return out;
}

/** One line per pack, for the evening brief and Hana's answer. */
export function packLine(p: PrepPack): string {
  const bits = [
    p.questions.length ? `${p.questions.length} question${p.questions.length === 1 ? '' : 's'} to ask` : 'no questions listed yet',
    p.medications.length ? `${p.medications.length} medication${p.medications.length === 1 ? '' : 's'} on the list` : '',
    p.records.length ? `${p.records.length} record${p.records.length === 1 ? '' : 's'} to bring or mention` : '',
  ].filter(Boolean);
  return `Prep for ${p.member === 'the family' ? 'the family’s' : possessive(p.member)} ${p.title.replace(new RegExp(`^${p.member}[’']?s?\\s+`, 'i'), '')}${p.time ? ` at ${p.time.slice(0, 5)}` : ''}: ${bits.join(', ')}.`;
}
