/**
 * JP2, messaging — consent first (migrations/066_messaging.sql).
 *
 * A grown-up may connect their OWN messages (MyDay's Feed Messages) to Hana. Off until they do.
 * Then each message that reaches them gets the C1 treatment: the shield reads it first (a scam is
 * a warning to them, and its asks never become to-dos); otherwise a one-line summary, and what it
 * commits anyone to becomes THEIR private loops (a reply from the one who owed it closes one).
 * Replies are drafts in the ladder (T2): sent only when they approve, only to someone who wrote
 * to them. The message is data from outside — never instructions.
 *
 * Kids: MyDay has no messaging for kids. The consent record is ready: safety SIGNALS to the
 * parents only (never content), parent-set, disclosed to the kid, off by default.
 */
import type { HouseholdMember, KidMessageSafety, MessageItem } from '@myday/shared';
import { asSystem, inHousehold, pool } from '../../db.js';
import { ruleTriage, triageEmail } from '../extract.js';
import { today } from '../dates.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';
import { currentKeyId, openText, sealText } from '../seal.js';
import { openLoop } from './loops.js';
import { screenMail } from './shield.js';

export const requireAdultMsg = (me: HouseholdMember): void => {
  if (me.kind !== 'adult') throw new HttpError(403, 'Connecting messages is for grown-ups');
};

export async function connected(memberId: number): Promise<boolean> {
  const { rows } = await pool.query<{ connected: boolean }>("SELECT connected FROM message_channels WHERE member_id = $1 AND kind = 'feed_dm'", [memberId]);
  return !!rows[0]?.connected;
}

/** Only you connect your own messages. Turning it off forgets Hana's copies. */
export async function setConnected(me: HouseholdMember, on: boolean): Promise<void> {
  requireAdultMsg(me);
  await pool.query(
    `INSERT INTO message_channels (member_id, kind, connected, updated_at) VALUES ($1, 'feed_dm', $2, $3)
     ON CONFLICT (member_id, kind) DO UPDATE SET connected = $2, updated_at = $3`,
    [me.id, on, new Date()],
  );
  if (!on) await pool.query('DELETE FROM message_items WHERE member_id = $1', [me.id]);
}

/** Called when a Feed message reaches a user: if they connected Messages, read it for them — in their own household. */
export async function messageArrived(toUserId: number, fromUserId: number, dmId: number, body: string, request = false): Promise<void> {
  const who = await asSystem(async () => {
    const { rows } = await pool.query<{ member_id: number | null; household_id: number | null }>(
      'SELECT u.member_id, m.household_id FROM users u LEFT JOIN household_members m ON m.id = u.member_id WHERE u.id = $1',
      [toUserId],
    );
    const { rows: p } = await pool.query<{ display_name: string }>('SELECT display_name FROM social_profiles WHERE user_id = $1', [fromUserId]);
    return { member: rows[0]?.member_id ?? null, hh: rows[0]?.household_id ?? null, from: p[0]?.display_name ?? 'Someone' };
  });
  if (!who.member || !who.hh) return;
  const member = who.member;
  await inHousehold(who.hh, async () => {
    if (!(await connected(member))) return;
    const kids = (await listMembers()).filter((m) => m.kind === 'kid').map((m) => ({ id: m.id, name: m.name }));
    const mail = { from: `${who.from} <messages@myday>`, subject: `Message from ${who.from}`, text: body };
    const shield = screenMail(mail, kids);
    const keyId = currentKeyId();
    const ref = `dm:${dmId}`;
    if (shield) {
      await pool.query(
        `INSERT INTO shield_alerts (kind, ref, about_member, text, signals, for_member, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (household_id, ref) DO NOTHING`,
        [shield.kind, ref, shield.aboutMember, shield.text, shield.signals, member, new Date()],
      );
    }
    const tri = shield?.scam ? { class: 'people' as const, summary: `${who.from}: flagged by the shield — see the warning`, commitments: [] } : await triageEmail(mail, today()).catch(() => ruleTriage(mail, today()));
    const { rowCount } = await pool.query(
      `INSERT INTO message_items (member_id, ext_ref, from_user_id, from_name, class, summary_enc, key_id, request, flagged, received_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (household_id, ext_ref) DO NOTHING`,
      [member, ref, fromUserId, who.from, tri.class, sealText(tri.summary, keyId), keyId, request, !!shield?.scam, new Date()],
    );
    if (!rowCount || shield?.scam) return;
    // A reply from someone who owed this grown-up something closes it — on that evidence, said plainly.
    await pool.query(
      "UPDATE open_loops SET closed_at = $1, closed_evidence = $2 WHERE source = 'message' AND NOT ours AND owed_by_name = $3 AND opened_by = $4 AND closed_at IS NULL",
      [new Date(), `A reply from ${who.from} arrived in Messages`, who.from, member],
    );
    const me = (await listMembers()).find((m) => m.id === member);
    if (!me) return;
    for (const [k, c] of tri.commitments.entries()) {
      await openLoop(me, { what: c.what, owedBy: c.owedBy === 'us' ? 'me' : who.from, due: c.due, source: 'message', sourceRef: `${ref}:${k}`, private: true });
    }
  });
}

/** Their messages, as Hana keeps them: who, when, her line — theirs alone. */
export async function inboxFor(me: HouseholdMember): Promise<MessageItem[]> {
  const { rows } = await pool.query<{ id: number; from_name: string; from_user_id: number | null; class: string; summary_enc: Buffer; key_id: string; request: boolean; flagged: boolean; received_at: Date }>(
    'SELECT id, from_name, from_user_id, class, summary_enc, key_id, request, flagged, received_at FROM message_items WHERE member_id = $1 ORDER BY received_at DESC, id DESC LIMIT 30',
    [me.id],
  );
  return rows.map((r) => ({ id: r.id, from: r.from_name, fromUserId: r.from_user_id, class: r.class, summary: openText(r.summary_enc, r.key_id), request: r.request, flagged: r.flagged, at: r.received_at.toISOString() }));
}

/** Who they may reply to through Hana: only someone who wrote to them (never a new recipient). */
export async function replyTarget(me: HouseholdMember, name: string): Promise<{ userId: number; name: string }> {
  requireAdultMsg(me);
  if (!(await connected(me.id))) throw new HttpError(400, 'Messages aren’t connected to Hana — connect them in Settings first');
  const { rows } = await pool.query<{ from_user_id: number; from_name: string }>(
    'SELECT DISTINCT ON (from_user_id) from_user_id, from_name FROM message_items WHERE member_id = $1 AND from_user_id IS NOT NULL AND NOT flagged AND lower(from_name) LIKE $2 ORDER BY from_user_id, received_at DESC',
    [me.id, `%${name.trim().toLowerCase()}%`],
  );
  if (rows.length !== 1) throw new HttpError(rows.length ? 409 : 404, rows.length ? `Which one — ${rows.map((r) => r.from_name).join(' or ')}?` : `Hana can only reply to someone who wrote to you in Messages — nobody called “${name}” has`);
  const r = rows[0] as { from_user_id: number; from_name: string };
  return { userId: r.from_user_id, name: r.from_name };
}

export async function userIdOf(me: HouseholdMember): Promise<number> {
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM users WHERE member_id = $1 ORDER BY id LIMIT 1', [me.id]);
  if (!rows[0]) throw new HttpError(400, 'Your account isn’t set up for Messages');
  return rows[0].id;
}

/* ---------- kids: the consent record for safety signals ---------- */

export async function kidSafety(kidId: number): Promise<KidMessageSafety> {
  const names = new Map((await listMembers()).map((m) => [m.id, m.name]));
  const { rows } = await pool.query<{ signals_on: boolean; set_by: number | null; updated_at: Date }>('SELECT signals_on, set_by, updated_at FROM kid_message_safety WHERE member_id = $1', [kidId]);
  const r = rows[0];
  return { memberId: kidId, member: names.get(kidId) ?? '?', signalsOn: !!r?.signals_on, setBy: r?.set_by ? (names.get(r.set_by) ?? null) : null, updatedAt: r?.updated_at.toISOString() ?? null, source: null };
}

export async function setKidSafety(me: HouseholdMember, kidId: number, on: boolean): Promise<KidMessageSafety> {
  const kid = (await listMembers()).find((m) => m.id === kidId);
  if (!kid) throw new HttpError(404, 'Not found');
  if (me.kind !== 'adult' || kid.kind !== 'kid') throw new HttpError(403, me.kind === 'kid' ? 'Your grown-ups choose this — you can always see it here' : 'This is for kids’ messages');
  await pool.query(
    `INSERT INTO kid_message_safety (member_id, signals_on, set_by, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (member_id) DO UPDATE SET signals_on = $2, set_by = $3, updated_at = $4`,
    [kidId, on, me.id, new Date()],
  );
  return kidSafety(kidId);
}

/** Told once, to the kid, whenever it changes — in plain words, including what it never does. */
export async function kidSafetyDisclosures(): Promise<Array<{ key: string; to: number; text: string }>> {
  const names = new Map((await listMembers()).map((m) => [m.id, m.name]));
  const { rows } = await pool.query<{ member_id: number; signals_on: boolean; set_by: number | null; updated_at: Date }>('SELECT member_id, signals_on, set_by, updated_at FROM kid_message_safety WHERE set_by IS NOT NULL');
  return rows.map((r) => ({
    key: `msgsafety:told:${r.member_id}:${r.updated_at.toISOString()}`,
    to: r.member_id,
    text: r.signals_on
      ? `${names.get(r.set_by as number) ?? 'A grown-up'} turned on safety alerts for your messages: if something looks unsafe — like someone asking you to keep a secret or to meet up — your grown-ups get a heads-up. They don’t read your messages.`
      : `${names.get(r.set_by as number) ?? 'A grown-up'} turned off safety alerts for your messages.`,
  }));
}
