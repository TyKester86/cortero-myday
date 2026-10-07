/**
 * Your data: export, delete your account, delete the whole household — all
 * self-serve (Settings → Your data). Plus the parent's consent that turns on
 * AI features for kids under 13 (COPPA).
 *
 * Export covers what's yours to take: your own records, your kids' records
 * (except their private notes, which only the child sees) and the household's
 * shared lists. Never another grown-up's personal data, and never secrets
 * (tokens, PIN hashes, encrypted bytes).
 */
import { Router, type Request } from 'express';
import type { HouseholdMember } from '@myday/shared';
import { asSystem, pool } from '../db.js';
import { logEvent } from '../lib/events.js';
import { HttpError, bool } from '../lib/http.js';
import { listMembers, memberByKey, requireAdult } from '../lib/members.js';
import { communityExport } from './community.js';
import { revokeItem } from './money.js';

export const accountRouter = Router();

/** Kids this young need a parent's OK before anything sends their words to an AI provider. */
export const AI_CONSENT_UNDER = 13;
export const needsAiConsent = (m: Pick<HouseholdMember, 'kind' | 'age'>): boolean => m.kind === 'kid' && (m.age === null || m.age < AI_CONSENT_UNDER);

/** Throws 409 'needs_parent_consent' when a young kid's parent hasn't turned AI features on. */
export async function requireAiConsent(m: HouseholdMember): Promise<void> {
  if (!needsAiConsent(m)) return;
  const { rows } = await pool.query<{ ok: boolean }>('SELECT ai_consent_at IS NOT NULL AS ok FROM household_members WHERE id = $1', [m.id]);
  if (!rows[0]?.ok) throw new HttpError(409, 'Ask a grown-up to turn on AI helpers for you (on their Family page).', 'needs_parent_consent');
}

/** A parent turns AI features on (or off) for a kid under 13. */
accountRouter.post('/api/household/members/:key/ai-consent', async (req, res) => {
  const me = requireAdult(req);
  const kid = await memberByKey(String(req.params.key));
  if (!kid || kid.kind !== 'kid') throw new HttpError(404, 'No such kid');
  const on = bool((req.body as { consent?: unknown }).consent, 'consent');
  await pool.query('UPDATE household_members SET ai_consent_at = $2, ai_consent_by = $3 WHERE id = $1', [kid.id, on ? new Date() : null, on ? me.id : null]);
  await logEvent(on ? 'ai_consent_given' : 'ai_consent_withdrawn', { kid: kid.id }, me.id);
  res.json({ key: kid.key, consent: on });
});

/** Homework help style for a kid: hints first (default) or direct answers with the worked steps. */
accountRouter.post('/api/household/members/:key/tutor-style', async (req, res) => {
  const me = requireAdult(req);
  const kid = await memberByKey(String(req.params.key));
  if (!kid || kid.kind !== 'kid') throw new HttpError(404, 'No such kid');
  const direct = bool((req.body as { direct?: unknown }).direct, 'direct');
  await pool.query('UPDATE household_members SET tutor_direct = $2 WHERE id = $1', [kid.id, direct]);
  await logEvent('tutor_style_changed', { kid: kid.id, direct }, me.id);
  res.json({ key: kid.key, direct });
});

accountRouter.get('/api/household/ai-consent', async (req, res) => {
  requireAdult(req);
  const { rows } = await pool.query<{ key: string; name: string; age: number | null; at: Date | null; direct: boolean }>(
    "SELECT key, name, age, ai_consent_at AS at, tutor_direct AS direct FROM household_members WHERE kind = 'kid' AND archived_at IS NULL ORDER BY sort_order, id",
  );
  res.json({
    kids: rows.map((r) => ({ key: r.key, name: r.name, age: r.age, needsConsent: needsAiConsent({ kind: 'kid', age: r.age }), consentAt: r.at ? r.at.toISOString() : null, direct: r.direct })),
  });
});

/* ---------- export ---------- */

/** Columns never exported: secrets and raw encrypted bytes. */
const SECRET_COL = /(token|_enc$|hash|secret|password|p256dh|^auth$|endpoint|^data$|audio_path)/i;
/** Tables never exported: plumbing and other people's private things. */
const SKIP_TABLES = new Set(['session', 'idempotency_keys', 'events', 'request_log', 'care_access_log', 'push_subscriptions', 'migrations']);

accountRouter.get('/api/account/export', async (req, res) => {
  const me = requireAdult(req);
  const members = await listMembers();
  const mine = members.filter((m) => m.id === me.id || m.kind === 'kid').map((m) => m.id);
  const { rows: tables } = await pool.query<{ table_name: string; has_member: boolean }>(
    `SELECT c.table_name, bool_or(c.column_name = 'member_id') AS has_member
       FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      GROUP BY c.table_name HAVING bool_or(c.column_name = 'household_id')
      ORDER BY c.table_name`,
  );
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    if (SKIP_TABLES.has(t.table_name)) continue;
    const { rows: cols } = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [t.table_name],
    );
    const keep = cols.filter((c) => c.data_type !== 'bytea' && !SECRET_COL.test(c.column_name) && c.column_name !== 'household_id').map((c) => `"${c.column_name}"`);
    if (!keep.length) continue;
    let where = '';
    const params: unknown[] = [];
    if (t.table_name === 'household_members') {
      where = 'WHERE id = ANY($1)';
      params.push(mine);
    } else if (t.has_member) {
      where = 'WHERE member_id = ANY($1)';
      params.push(mine);
      // A kid's private notes are the kid's alone.
      if (t.table_name === 'private_notes') {
        where = 'WHERE member_id = $1';
        params.splice(0, 1, me.id);
      }
    }
    const { rows } = await pool.query(`SELECT ${keep.join(', ')} FROM "${t.table_name}" ${where}`, params);
    if (rows.length) out[t.table_name] = rows;
  }
  await logEvent('data_exported', { tables: Object.keys(out).length }, me.id);
  res.setHeader('Content-Disposition', `attachment; filename="myday-export-${new Date().toISOString().slice(0, 10)}.json"`);
  // Your Village/Feed profile and posts (decrypted for you). Nobody else's.
  const community = req.user ? await communityExport(req.user.id) : null;
  res.json({
    exportedAt: new Date().toISOString(),
    by: me.name,
    note: 'Your records, your kids’ records (not their private notes), the household’s shared lists, and your own community posts.',
    data: out,
    community,
  });
});

/* ---------- delete ---------- */

async function endSession(req: Request): Promise<void> {
  await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
}

/** Delete your own account. The last grown-up deletes the household instead (the kids would be left alone). */
accountRouter.delete('/api/account', async (req, res) => {
  const me = requireAdult(req);
  if (req.query.confirm !== 'DELETE') throw new HttpError(409, 'Type DELETE to confirm');
  const adults = (await listMembers()).filter((m) => m.kind === 'adult');
  if (adults.length <= 1) {
    throw new HttpError(409, 'You’re the only grown-up here — delete the whole household instead (the kids can’t stay on their own).', 'last_adult');
  }
  const userId = req.user?.id;
  await logEvent('account_deleted', {}, null);
  // Everything that's only yours goes with your member row (cascade); shared lists stay with the household.
  await pool.query('DELETE FROM household_members WHERE id = $1', [me.id]);
  if (userId) await asSystem(() => pool.query('DELETE FROM users WHERE id = $1', [userId]));
  await endSession(req);
  res.json({ deleted: 'account' });
});

/** Delete the whole household and everything in it (needs the exact household name). */
accountRouter.delete('/api/household', async (req, res) => {
  requireAdult(req);
  const hh = req.householdId;
  if (!hh) throw new HttpError(409, 'No household');
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM households WHERE id = $1', [hh]);
  const name = rows[0]?.name ?? '';
  if (typeof req.query.confirm !== 'string' || req.query.confirm !== name) throw new HttpError(409, 'Type the household’s exact name to delete it');
  // Banks: revoke access at the provider first.
  const { rows: items } = await pool.query<{ id: number; access_token_enc: string; provider: string }>('SELECT id, access_token_enc, provider FROM money_items');
  for (const it of items) await revokeItem(it.id, it);
  const { rows: users } = await pool.query<{ id: number }>('SELECT u.id FROM users u JOIN household_members m ON m.id = u.member_id');
  await asSystem(async () => {
    await pool.query('DELETE FROM households WHERE id = $1', [hh]);
    if (users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [users.map((u) => u.id)]);
  });
  await asSystem(() => logEvent('household_deleted', { self: true }, null, null));
  await endSession(req);
  res.json({ deleted: 'household' });
});
