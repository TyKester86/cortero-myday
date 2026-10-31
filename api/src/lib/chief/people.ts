/**
 * JP5, people dossiers: the household's teachers, doctors, coaches, kin and sitters — who they
 * are, when we last heard from them, what's open with them (C4), what's coming up — built from
 * what the household already holds (forwarded mail, loops, the calendar, the family memory,
 * medications). Parents only; nothing leaves the household unless a parent sends it.
 *
 * "What matters" is by role, never everything: the sitter gets allergies and the medicine
 * schedule, not anecdotes; a coach gets the medical basics; a teacher the school facts and what
 * worked; kin get sizes and likes. Money, private memories and anyone not in their care: never.
 */
import type { DateStr, HouseholdMember, Person, PersonDossier, PersonRole, PeopleView } from '@myday/shared';
import { pool } from '../../db.js';
import { addDays, today } from '../dates.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';
import { openText } from '../seal.js';
import { loopsFor } from './loops.js';
import { listMeds } from './healthops.js';
import { viewerOf } from './scope.js';
import { scheduleFor } from './tools.js';
import { SOURCE } from './facts.js';

export const PEOPLE_SOURCE = SOURCE.people;
export const ROLES: [PersonRole, ...PersonRole[]] = ['teacher', 'doctor', 'coach', 'kin', 'sitter', 'other'];
const ROLE_LABEL: Record<PersonRole, string> = { teacher: 'teacher', doctor: 'doctor', coach: 'coach', kin: 'family', sitter: 'sitter', other: 'contact' };
/** Which family-memory kinds each role needs to know about the kids in their care. */
const ROLE_KINDS: Record<PersonRole, string[]> = { sitter: ['medical', 'preference'], coach: ['medical', 'size'], teacher: ['medical', 'school', 'worked'], doctor: ['medical'], kin: ['size', 'preference'], other: [] };
const ROLE_MEDS: Record<PersonRole, boolean> = { sitter: true, doctor: true, coach: false, teacher: false, kin: false, other: false };

export const requireParentPeople = (me: HouseholdMember): void => {
  if (me.kind !== 'adult') throw new HttpError(403, 'People dossiers are for grown-ups');
};

/** Words that identify someone in text: the surname (and the full name). "Mrs. Ortiz" → ortiz. */
function tokens(name: string): string[] {
  const parts = name.replace(/\b(mr|mrs|ms|miss|dr|coach|aunt|uncle|grandma|grandpa)\.?\s+/gi, '').split(/\s+/).filter((w) => w.length >= 3);
  return [...new Set([name.toLowerCase(), ...(parts.length ? [parts[parts.length - 1]?.toLowerCase() ?? ''] : [])].filter(Boolean))];
}
const mentions = (text: string, toks: string[]): boolean => toks.some((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));

interface Row {
  id: number;
  name: string;
  role: PersonRole;
  email: string;
  phone: string;
  org: string;
  notes: string;
}

async function rows(): Promise<Array<Row & { members: number[] }>> {
  const { rows: ps } = await pool.query<Row>('SELECT id, name, role, email, phone, org, notes FROM people ORDER BY role, name');
  const { rows: links } = await pool.query<{ person_id: number; member_id: number }>('SELECT person_id, member_id FROM person_members');
  return ps.map((p) => ({ ...p, members: links.filter((l) => l.person_id === p.id).map((l) => l.member_id) }));
}

function toPerson(p: Row & { members: number[] }, names: Map<number, string>): Person {
  return { id: p.id, name: p.name, role: p.role, email: p.email, phone: p.phone, org: p.org, notes: p.notes, forIds: p.members, forNames: p.members.map((id) => names.get(id) ?? '?') };
}

export async function dossier(me: HouseholdMember, id: number): Promise<PersonDossier> {
  requireParentPeople(me);
  const p = (await rows()).find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'No such person');
  const members = await listMembers();
  const names = new Map(members.map((m) => [m.id, m.name]));
  const toks = tokens(p.name);
  const t = today();
  const v = viewerOf(me);

  // Last contact: their mail (by address), or a calendar event naming them.
  const contacts: Array<{ date: DateStr; how: string; what: string }> = [];
  if (p.email) {
    const { rows: mail } = await pool.query<{ received_at: Date; summary_enc: Buffer | null; subject_enc: Buffer; key_id: string }>(
      "SELECT received_at, summary_enc, subject_enc, key_id FROM inbox_emails WHERE lower(from_addr) LIKE $1 ORDER BY received_at DESC LIMIT 1",
      [`%${p.email.toLowerCase()}%`],
    );
    const m = mail[0];
    if (m) contacts.push({ date: m.received_at.toISOString().slice(0, 10) as DateStr, how: 'mail', what: m.summary_enc ? openText(m.summary_enc, m.key_id) : openText(m.subject_enc, m.key_id) });
  }
  const past = (await scheduleFor(v, addDays(t, -365) as DateStr, t)).data.filter((e) => !e.busy && mentions(`${e.title} ${e.location}`, toks));
  const lastEv = past[past.length - 1];
  if (lastEv) contacts.push({ date: lastEv.date, how: 'calendar', what: lastEv.title });
  contacts.sort((a, b) => b.date.localeCompare(a.date));

  const upcoming = (await scheduleFor(v, t, addDays(t, 60) as DateStr)).data
    .filter((e) => !e.busy && mentions(`${e.title} ${e.location}`, toks))
    .slice(0, 5)
    .map((e) => ({ date: e.date, time: e.time, title: e.title }));
  const loops = (await loopsFor(v)).filter((l) => l.open && mentions(`${l.what} ${l.owedBy}`, toks)).map((l) => ({ id: l.id, what: l.what, owedBy: l.owedBy, due: l.due }));
  const { rows: mem } = await pool.query<{ fact: string }>('SELECT fact FROM hana_memories WHERE shared ORDER BY id');
  const known = mem.map((r) => r.fact).filter((f) => mentions(f, toks));

  // What they need to know, by role, about the kids (or members) in their care only.
  const matters: PersonDossier['matters'] = [];
  const kinds = ROLE_KINDS[p.role];
  if (p.members.length && kinds.length) {
    const { rows: facts } = await pool.query<{ fact: string; kind: string; about_member_id: number }>(
      'SELECT fact, kind, about_member_id FROM hana_memories WHERE shared AND about_member_id = ANY($1) AND kind = ANY($2) ORDER BY about_member_id, kind, id',
      [p.members, kinds],
    );
    for (const f of facts) matters.push({ about: names.get(f.about_member_id) ?? '?', what: f.fact, from: 'Family memory' });
  }
  if (p.members.length && ROLE_MEDS[p.role]) {
    for (const m of (await listMeds()).filter((x) => x.active && p.members.includes(x.memberId))) {
      matters.push({ about: m.member, what: `${m.name}${m.dose ? ` ${m.dose}` : ''}${m.schedule ? `, ${m.schedule}` : ''}`, from: 'Medications' });
    }
  }
  const forNames = p.members.map((id) => names.get(id) ?? '?');
  const shareCard = matters.length
    ? [`For ${p.name} (${ROLE_LABEL[p.role]}${forNames.length ? ` for ${forNames.join(' and ')}` : ''}):`, ...matters.map((x) => `• ${forNames.length > 1 ? `${x.about}: ` : ''}${x.what}`)].join('\n')
    : null;
  return {
    person: toPerson(p, names),
    lastContact: contacts[0] ?? null,
    openLoops: loops,
    upcoming,
    known,
    matters,
    shareCard,
    source: PEOPLE_SOURCE,
    asOf: new Date().toISOString(),
  };
}

/** People the household's mail and medications already mention who aren't on the list yet. */
async function suggestions(existing: Array<Row & { members: number[] }>): Promise<PeopleView['suggestions']> {
  const emails = new Set(existing.map((p) => p.email.toLowerCase()).filter(Boolean));
  const names = existing.flatMap((p) => tokens(p.name));
  const { rows: mail } = await pool.query<{ from_addr: string; class: string | null; n: number; last: Date }>(
    `SELECT from_addr, max(class) AS class, count(*)::int AS n, max(received_at) AS last FROM inbox_emails e
      WHERE COALESCE(class, 'people') IN ('school', 'medical', 'people', 'logistics')
        AND NOT EXISTS (SELECT 1 FROM shield_alerts s WHERE s.email_id = e.id AND s.kind <> 'account_security' AND COALESCE(s.verdict, 'scam') = 'scam')
      GROUP BY from_addr ORDER BY max(received_at) DESC LIMIT 30`,
  );
  const out: PeopleView['suggestions'] = [];
  for (const m of mail) {
    const addr = m.from_addr.match(/<([^>]+)>/)?.[1] ?? m.from_addr.trim();
    const display = m.from_addr.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim() ?? '';
    if (!addr || emails.has(addr.toLowerCase()) || (display && mentions(display, names)) || /no-?reply|notifications?@|mailer/i.test(addr)) continue;
    out.push({ name: display || addr, email: addr, role: m.class === 'school' ? 'teacher' : m.class === 'medical' ? 'doctor' : 'other', why: `Wrote ${m.n} time${m.n === 1 ? '' : 's'} (last ${m.last.toISOString().slice(0, 10)})` });
  }
  for (const med of await listMeds()) {
    if (med.prescriber && !mentions(med.prescriber, names) && !out.some((o) => o.name === med.prescriber)) out.push({ name: med.prescriber, email: '', role: 'doctor', why: `Prescribes ${med.member}’s ${med.name}` });
  }
  return out.slice(0, 10);
}

export async function peopleView(me: HouseholdMember): Promise<PeopleView> {
  requireParentPeople(me);
  const all = await rows();
  const names = new Map((await listMembers()).map((m) => [m.id, m.name]));
  return { people: all.map((p) => toPerson(p, names)), suggestions: await suggestions(all) };
}

export async function personByName(text: string): Promise<number> {
  const all = await rows();
  // By any part of their name ("Jess", "Rivera", "Mrs. Ortiz").
  const parts = (n: string): string[] => n.replace(/\b(mr|mrs|ms|miss|dr|coach|aunt|uncle|grandma|grandpa)\.?\s+/gi, '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const hit = all.filter((p) => mentions(text, tokens(p.name)) || mentions(text, parts(p.name)) || p.name.toLowerCase() === text.trim().toLowerCase());
  if (hit.length !== 1) throw new HttpError(hit.length ? 409 : 404, hit.length ? `Which one — ${hit.map((p) => p.name).join(' or ')}?` : `${text} isn’t on the family’s people list yet (add them in Family HQ)`);
  return (hit[0] as Row).id;
}

export async function savePerson(me: HouseholdMember, id: number | null, b: { name: string; role: PersonRole; email: string; phone: string; org: string; notes: string; forIds: number[] }): Promise<Person> {
  requireParentPeople(me);
  const members = await listMembers();
  if (b.forIds.some((x) => !members.some((m) => m.id === x))) throw new HttpError(400, 'Pick people in this household');
  let pid = id;
  if (pid === null) {
    pid = (await pool.query<{ id: number }>('INSERT INTO people (name, role, email, phone, org, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [b.name, b.role, b.email, b.phone, b.org, b.notes, me.id])).rows[0]?.id ?? null;
  } else {
    const { rowCount } = await pool.query('UPDATE people SET name = $2, role = $3, email = $4, phone = $5, org = $6, notes = $7 WHERE id = $1', [pid, b.name, b.role, b.email, b.phone, b.org, b.notes]);
    if (!rowCount) throw new HttpError(404, 'No such person');
    await pool.query('DELETE FROM person_members WHERE person_id = $1', [pid]);
  }
  for (const m of b.forIds) await pool.query('INSERT INTO person_members (person_id, member_id) VALUES ($1, $2)', [pid, m]);
  const p = (await rows()).find((x) => x.id === pid);
  return toPerson(p as Row & { members: number[] }, new Map(members.map((m) => [m.id, m.name])));
}
