/**
 * JP7, initiative rights (migrations/067_initiative.sql). The formal version of "proactive": Hana
 * may start a conversation — a push, or a spoken heads-up on a device that asked for them (JP1) —
 * only for a NAMED reason that person has granted, inside quiet hours. Everything else waits for
 * the brief and Family HQ. Granted, tunable, revocable; the pause and the mutes (H9) still apply.
 *
 * Always on, and said so: safety (the alarm going off, a family-emergency scam) and telling a kid
 * what changed about them (who can see their location, their message safety alerts).
 */
import type { HanaWatchCategory, HouseholdMember, InitiativeReason, InitiativeView } from '@myday/shared';
import { INITIATIVE_REASONS } from '@myday/shared';
import { pool } from '../../db.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';

export type Reason = InitiativeReason | 'safety' | 'told';
export const GRANTABLE = INITIATIVE_REASONS.map((r) => r.reason);
const ADULT_DEFAULT: InitiativeReason[] = ['breaking', 'conflict', 'money', 'storm', 'scam', 'house'];
const KID_DEFAULT: InitiativeReason[] = ['storm'];

/** Why a heads-up may interrupt — or null: it waits for the brief. */
export function reasonOf(f: { category: HanaWatchCategory | 'escalation'; sameDay: boolean; key: string }): Reason | null {
  switch (f.category) {
    case 'loops':
    case 'homework':
    case 'escalation':
      return 'breaking';
    case 'pickup':
    case 'conflict':
      return 'conflict';
    case 'bills':
    case 'money':
      return 'money';
    case 'storm':
      return 'storm';
    case 'house':
      return f.key.startsWith('house:alarm:') ? 'safety' : 'house';
    case 'shield':
      return f.sameDay ? 'safety' : 'scam';
    case 'location':
    case 'messages':
      return 'told';
    default:
      // expiry, health: real, but not worth an interruption — they're in the brief.
      return null;
  }
}

export const REASON_TITLE: Record<Reason, string> = {
  breaking: 'Hana: a loop about to break',
  conflict: 'Hana: a conflict just formed',
  money: 'Hana: a money heads-up',
  storm: 'Hana: severe weather',
  scam: 'Hana: a scam warning',
  house: 'Hana: the house',
  safety: 'Hana: safety',
  told: 'Hana: something changed for you',
};

export async function grantsOf(member: HouseholdMember): Promise<InitiativeReason[]> {
  const { rows } = await pool.query<{ reasons: string[] }>('SELECT reasons FROM hana_initiative WHERE member_id = $1', [member.id]);
  const r = rows[0];
  if (!r) return member.kind === 'adult' ? [...ADULT_DEFAULT] : [...KID_DEFAULT];
  return GRANTABLE.filter((x) => r.reasons.includes(x));
}

/** May this heads-up interrupt this person? (Quiet hours are the watch's to apply.) */
export async function mayInterrupt(member: HouseholdMember, reason: Reason | null): Promise<boolean> {
  if (reason === 'safety' || reason === 'told') return true;
  if (!reason) return false;
  return (await grantsOf(member)).includes(reason);
}

/** A grown-up sets their own; the parents set a kid's. */
export async function setGrants(me: HouseholdMember, memberId: number, reasons: unknown): Promise<InitiativeView> {
  const target = (await listMembers()).find((m) => m.id === memberId);
  if (!target) throw new HttpError(404, 'Not found');
  if (!(me.id === target.id && me.kind === 'adult') && !(me.kind === 'adult' && target.kind === 'kid')) {
    throw new HttpError(403, me.kind === 'kid' ? 'Your grown-ups choose when Hana may start a conversation with you' : 'Each grown-up sets their own');
  }
  if (!Array.isArray(reasons) || reasons.some((r) => !(GRANTABLE as unknown[]).includes(r))) throw new HttpError(400, `Reasons are ${GRANTABLE.join(', ')}`);
  await pool.query(
    `INSERT INTO hana_initiative (member_id, reasons, set_by, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (member_id) DO UPDATE SET reasons = $2, set_by = $3, updated_at = $4`,
    [memberId, [...new Set(reasons as string[])], me.id, new Date()],
  );
  return viewOf(target);
}

/** What someone has granted, what's always on, and the last times she started a conversation — with why. */
export async function viewOf(member: HouseholdMember): Promise<InitiativeView> {
  const { rows } = await pool.query<{ id: number; reason: string | null; text: string; pushed_at: Date }>(
    "SELECT id, reason, text, pushed_at FROM hana_items WHERE member_id = $1 AND pushed_at IS NOT NULL ORDER BY pushed_at DESC, id DESC LIMIT 20",
    [member.id],
  );
  return {
    memberId: member.id,
    member: member.name,
    granted: await grantsOf(member),
    always: ['safety', 'told'],
    recent: rows.map((r) => ({ id: r.id, reason: (r.reason ?? 'breaking') as Reason, title: REASON_TITLE[(r.reason ?? 'breaking') as Reason], text: r.text, at: r.pushed_at.toISOString() })),
  };
}
