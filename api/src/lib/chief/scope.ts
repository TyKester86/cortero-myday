/**
 * Hana as the household's chief of staff: who is asking, and what they may see.
 *
 * Every read in lib/chief takes a Viewer and applies its scope in the query layer
 * (never by prompt instruction):
 *  - household: row-level security on every table (one household never sees another);
 *  - role: a parent sees the whole family board; a child sees only their own day —
 *    no siblings' items, no grown-ups-only events, no money, no Feed.
 */
import type { HouseholdMember } from '@myday/shared';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';

export interface Viewer {
  me: HouseholdMember;
  parent: boolean;
}

export const viewerOf = (me: HouseholdMember): Viewer => ({ me, parent: me.kind === 'adult' });

/** Parent-only data (money, the Feed, other people's items): a child's call never gets it. */
export function requireParent(v: Viewer, what: string): void {
  if (!v.parent) throw new HttpError(403, `${what} is for parents`);
}

/** The people whose items this viewer may see: a parent, everyone; a child, only themselves. */
export async function visibleMembers(v: Viewer): Promise<HouseholdMember[]> {
  const all = await listMembers();
  return v.parent ? all : all.filter((m) => m.id === v.me.id);
}

/** A parent may look at one family member; a child only at themselves. */
export async function scopedMember(v: Viewer, name: string | null | undefined): Promise<HouseholdMember[]> {
  const people = await visibleMembers(v);
  if (!name) return people;
  const who = people.filter((m) => m.name.toLowerCase() === name.trim().toLowerCase() || m.key === name.trim().toLowerCase());
  if (!who.length) throw new HttpError(404, v.parent ? `There’s no one named ${name} in this household` : 'You can only look at your own day');
  return who;
}
