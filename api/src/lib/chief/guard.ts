/**
 * Hana's hard lines, enforced in code (not by asking the model nicely):
 *
 *  - Crisis: the same rule the Feed and Village use (screen.ts). A crisis signal in
 *    anything she processes — a chat message from a kid or a grown-up, Feed content —
 *    means she stops, shows crisis resources, and alerts BOTH parents (in the app,
 *    by push, by email, with no message text) plus MyDay staff, as the Feed does.
 *    She never handles it alone or silently.
 *  - Health: organization and reminders only. A personal symptom question gets what
 *    the family's records show and "a clinician is the right call" — every time, with
 *    no model involved, so nothing can drift into diagnosis or advice.
 */
import { CRISIS_RESOURCES, type HouseholdMember } from '@myday/shared';
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { today } from '../dates.js';
import { logEvent } from '../events.js';
import { sendMail } from '../mail.js';
import { listMembers } from '../members.js';
import { CopyPolicyError, sendTo } from '../push.js';
import { ruleScreen } from '../screen.js';
import { healthFor } from './tools.js';
import { viewerOf } from './scope.js';
import { SOURCE } from './facts.js';

/** The Feed's crisis rule, verbatim. */
export const crisisIn = (text: string): boolean => ruleScreen(text).includes('crisis');

export type CrisisWhere = 'chat' | 'tutor' | 'feed';

const WHERE_WORDS: Record<CrisisWhere, string> = { chat: 'a chat with Hana', tutor: 'a homework chat with Hana', feed: 'something Hana read on the Feed' };

/**
 * Escalate to both parents. The alert never quotes the content (it may be private);
 * it says who and where, and to check in now.
 */
export async function escalateCrisis(about: HouseholdMember, where: CrisisWhere): Promise<{ parents: string[] }> {
  const parents = (await listMembers()).filter((m) => m.kind === 'adult');
  const day = today();
  const key = `crisis:${where}:${about.id}:${Date.now()}`;
  const text = `Something in ${WHERE_WORDS[where]} with ${about.name} may mean they need support right now. Please check in with ${about.name} now. If anyone is in immediate danger, call 911.`;
  for (const p of parents) {
    await pool.query(
      `INSERT INTO hana_items (member_id, surface, category, item_key, subject_member_id, text, source, as_of, shown_on)
       VALUES ($1, 'crisis', 'crisis', $2, $3, $4, $5, now(), $6) ON CONFLICT DO NOTHING`,
      [p.id, key, about.id, text, where === 'feed' ? SOURCE.feed : 'Hana chat', day],
    );
    try {
      await sendTo(p.id, { title: `Please check in with ${about.name}`, body: `Hana saw something that may mean ${about.name} needs support now. Open MyDay for next steps.`, url: '/hq' });
    } catch (e) {
      if (!(e instanceof CopyPolicyError)) console.error('crisis push', e);
    }
  }
  const { rows: mail } = await pool.query<{ email: string }>(
    "SELECT DISTINCT u.email FROM users u JOIN household_members m ON m.id = u.member_id WHERE m.kind = 'adult' AND m.archived_at IS NULL AND u.email LIKE '%@%'",
  );
  for (const r of mail) {
    await sendMail({
      to: r.email,
      subject: `MyDay: please check in with ${about.name}`,
      text: `Hana noticed something in ${WHERE_WORDS[where]} that may mean ${about.name} needs support right now. Please check in with ${about.name} now.\n\nIf anyone is in immediate danger, call 911. The 988 Suicide & Crisis Lifeline (call or text 988) and the Childhelp hotline (1-800-422-4453) are there any time.\n\nOpen MyDay: ${config.publicUrl}/hq`,
    }).catch(() => false);
  }
  // MyDay staff, exactly as a held Feed post: no content in the email.
  for (const to of config.adminEmails) {
    await sendMail({ to, subject: 'MyDay: Hana escalated a possible crisis to a family', text: `Hana escalated a possible crisis (${where}) to a household's parents. No content is included.` }).catch(() => false);
  }
  await logEvent('hana_crisis', { where, parents: parents.length }, about.id);
  return { parents: parents.map((p) => p.name) };
}

/** What Hana says instead of answering, when a message carries a crisis signal. */
export function crisisReply(me: HouseholdMember, parents: string[]): string {
  const others = parents.filter((n) => n !== me.name);
  const told = me.kind === 'kid' ? 'I’ve let your parents know so they can be with you.' : others.length ? `I’ve let ${others.join(' and ')} know too, so you’re not alone in this.` : 'I’ve flagged it so you’re not alone in this.';
  return [
    'I’m really glad you told me. You deserve support right now, and this is bigger than something I should handle alone.',
    ...CRISIS_RESOURCES.map((r) => `• ${r.label}`),
    told,
  ].join('\n');
}

/* ---------- health boundary ---------- */

/** A personal symptom question (theirs or a family member's) — not a homework question about biology. */
const SYMPTOM =
  /\b(i|i'?m|im|my|me|we|our|he|she|they|his|her|their|son|daughter|kid|kids|child|baby|wife|husband|partner)\b[^.?!\n]{0,60}\b(hurts?|hurting|pain|aches?|aching|fever|rash|dizzy|dizziness|nause\w*|vomit\w*|throw(?:ing)? up|cough\w*|headaches?|migraines?|bleed\w*|swollen|swelling|lump|sick|symptoms?|infect\w*|sore|faint\w*|numb\w*|shortness of breath|can'?t breathe|chest pain|side effects?)\b/i;

export const symptomQuestion = (text: string): boolean => SYMPTOM.test(text.replace(/’/g, "'"));

export const CLINICIAN = 'A clinician is the right call.';

/** Records only — what the family entered — and the clinician line. Never interpretation. */
export async function clinicianReply(me: HouseholdMember): Promise<string> {
  const v = viewerOf(me);
  const h = await healthFor(v);
  const lines: string[] = [];
  for (const d of h.data) {
    const appts = d.appointments.slice(0, 3).map((a) => `${a.title} on ${a.date}${a.time ? ` at ${a.time}` : ''}`);
    if (appts.length) lines.push(`${d.member}: coming up — ${appts.join('; ')}`);
  }
  const records = lines.length
    ? `Here’s what your family’s MyDay records show: ${lines.join('. ')}. (Source: the family calendar.)`
    : 'MyDay doesn’t have any appointments on the family calendar for this in the next two weeks.';
  return `I can’t tell what’s going on with symptoms, and I won’t guess — that’s not something I do. ${records} ${CLINICIAN} If it feels urgent, call your doctor’s after-hours line, or 911 in an emergency.`;
}
