/**
 * Joining an existing household with an invite — from the "Set up your
 * household" screen (no household yet) or while already in another one.
 *
 * Rules when you already have a household:
 *   - other grown-ups are still there → just YOU move (your own tasks,
 *     check-ins, history come with you); that household stays as it is;
 *   - you're the only grown-up (alone, or only kids remain) → the whole
 *     household moves in with you — kids, chores and data are never left
 *     behind — and the empty shell is removed;
 *   - an empty, unused household is simply removed.
 * Nothing moves until the person confirms ("leave": true).
 */
import { Router, type Request } from 'express';
import type { JoinPreview } from '@myday/shared';
import { asSystem, pool } from '../db.js';
import { claimAndLink, peekInvite } from '../auth.js';
import { logEvent } from '../lib/events.js';
import { absorbMember, hasRealData, householdContents, mergeHouseholds } from '../lib/householdMove.js';
import { HttpError, str } from '../lib/http.js';

export const joinRouter = Router();

/** Accepts a full invite link (…/join/<token>, …?invite=<token>) or the bare code. */
export function tokenFrom(input: string): string {
  const s = input.trim();
  const m = s.match(/\/join\/([A-Za-z0-9_-]+)/) ?? s.match(/[?&]invite=([A-Za-z0-9_-]+)/);
  return (m?.[1] ?? s).replace(/[^A-Za-z0-9_-]/g, '');
}

function tokenOf(req: Request): string {
  // An empty token means "the invite I signed in with" (held in the session).
  const raw = (req.body as { token?: unknown } | undefined)?.token || req.query.token || req.session.pendingInvite || '';
  const t = tokenFrom(str(raw, 'token', 400));
  if (!t) throw new HttpError(400, 'Paste the invite link or code');
  return t;
}

async function preview(req: Request, token: string): Promise<JoinPreview> {
  const inv = await peekInvite(token);
  if (!inv) throw new HttpError(404, 'That invite link is used, expired or was cancelled — ask for a new one');
  const me = req.member ?? null;
  const myHh = me ? (await asSystem(() => pool.query<{ household_id: number; name: string }>('SELECT m.household_id, h.name FROM household_members m JOIN households h ON h.id = m.household_id WHERE m.id = $1', [me.id]))).rows[0] : undefined;
  if (!me || !myHh) {
    return { household: inv.household, as: inv.name, current: null, outcome: 'join', explanation: `You’ll join ${inv.household} as ${inv.name}.` };
  }
  if (myHh.household_id === inv.householdId) {
    return { household: inv.household, as: inv.name, current: { name: myHh.name, adults: 0, kids: 0, hasData: false }, outcome: 'already_member', explanation: `You’re already in ${inv.household}.` };
  }
  const c = await householdContents(myHh.household_id);
  const others = c.members.filter((m) => m.id !== me.id);
  const adults = others.filter((m) => m.kind === 'adult').length;
  const kids = others.filter((m) => m.kind === 'kid').length;
  const data = hasRealData(c.rows);
  const current = { name: myHh.name, adults, kids, hasData: data };
  if (adults > 0) {
    return { household: inv.household, as: inv.name, current, outcome: 'move_person',
      explanation: `You’ll move to ${inv.household}, bringing your own tasks, check-ins and history. ${myHh.name} keeps its ${adults + kids} other ${adults + kids === 1 ? 'person' : 'people'} and everything shared there.` };
  }
  if (kids > 0 || data) {
    return { household: inv.household, as: inv.name, current, outcome: 'merge_household',
      explanation: `You’re the only grown-up in ${myHh.name}, so it moves in with you: ${kids ? `${kids} kid${kids === 1 ? '' : 's'}, ` : ''}chores, lists and history all come along. Nothing is lost; ${myHh.name} is then removed.` };
  }
  return { household: inv.household, as: inv.name, current, outcome: 'remove_empty', explanation: `${myHh.name} has nothing in it yet, so it’ll be removed when you join ${inv.household}.` };
}

joinRouter.get('/api/join/preview', async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  res.json(await preview(req, tokenOf(req)));
});

joinRouter.post('/api/join', async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  const token = tokenOf(req);
  const p = await preview(req, token);
  const inv = await peekInvite(token);
  if (!inv) throw new HttpError(404, 'That invite is no longer valid');
  if (p.outcome === 'already_member') throw new HttpError(409, p.explanation);
  const leave = (req.body as { leave?: unknown }).leave === true;
  if (p.outcome !== 'join' && !leave) throw new HttpError(409, `Leaving ${p.current?.name} needs your OK: ${p.explanation}`);
  const me = req.member ?? null;
  const userEmail = req.user.email;
  let fromHousehold: number | null = null;
  if (me && p.outcome !== 'join') {
    fromHousehold = (await asSystem(() => pool.query<{ household_id: number }>('SELECT household_id FROM household_members WHERE id = $1', [me.id]))).rows[0]?.household_id ?? null;
  }
  // Fold the person (and, if needed, their household) into the invited member.
  if (me && fromHousehold !== null) {
    if (p.outcome === 'move_person') await absorbMember(me.id, inv.memberId);
    else await mergeHouseholds(fromHousehold, inv.householdId, new Map([[me.id, inv.memberId]]));
  }
  await claimAndLink(token, req.user.id, userEmail);
  delete req.session.pendingInvite;
  await asSystem(() => logEvent('household_joined', { outcome: p.outcome }, inv.memberId, inv.householdId));
  res.json({ ok: true, outcome: p.outcome, explanation: p.explanation, household: inv.household });
});

/** "Not now" on the leave-and-join prompt. */
joinRouter.post('/api/join/dismiss', (req, res) => {
  delete req.session.pendingInvite;
  res.json({ ok: true });
});
