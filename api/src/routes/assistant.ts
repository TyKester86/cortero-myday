/**
 * Hana as a personal assistant (step 1): what she remembers about you and the
 * reminders she set for you (migrations/023_hana_assistant.sql). Both are
 * yours alone and visible on the Ask Hana page, where you can delete them.
 * Reminders go out as a push at their time (once each).
 */
import { Router } from 'express';
import { asSystem, inHousehold, pool } from '../db.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { self } from '../lib/members.js';
import { CopyPolicyError, pushConfigured, sendTo } from '../lib/push.js';
import { registerJob } from '../lib/schedulers.js';

export const assistantRouter = Router();

export interface HanaMemory {
  id: number;
  fact: string;
  at: string;
}
export interface HanaReminder {
  id: number;
  text: string;
  at: string;
}

assistantRouter.get('/api/hana/memory', async (req, res) => {
  const me = self(req);
  const { rows: mem } = await pool.query<{ id: number; fact: string; created_at: Date }>('SELECT id, fact, created_at FROM hana_memories WHERE member_id = $1 ORDER BY id', [me.id]);
  const { rows: rem } = await pool.query<{ id: number; text: string; remind_at: Date }>(
    'SELECT id, text, remind_at FROM hana_reminders WHERE member_id = $1 AND sent_at IS NULL ORDER BY remind_at',
    [me.id],
  );
  res.json({
    memories: mem.map((m): HanaMemory => ({ id: m.id, fact: m.fact, at: m.created_at.toISOString() })),
    reminders: rem.map((r): HanaReminder => ({ id: r.id, text: r.text, at: r.remind_at.toISOString() })),
  });
});

/** Tell Hana something to remember (or she saves it herself in chat). */
assistantRouter.post('/api/hana/memory', async (req, res) => {
  const me = self(req);
  const fact = str((req.body as { fact?: unknown }).fact, 'fact', 300, true);
  const { rows: n } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM hana_memories WHERE member_id = $1', [me.id]);
  if ((n[0]?.n ?? 0) >= 200) throw new HttpError(409, 'Hana is holding a lot already — forget a few first');
  await pool.query('INSERT INTO hana_memories (member_id, fact) VALUES ($1, $2)', [me.id, fact]);
  res.status(201).json({ ok: true });
});

/** Correct something Hana remembers. */
assistantRouter.patch('/api/hana/memory/:id', async (req, res) => {
  const me = self(req);
  const fact = str((req.body as { fact?: unknown }).fact, 'fact', 300, true);
  const { rowCount } = await pool.query('UPDATE hana_memories SET fact = $3 WHERE id = $1 AND member_id = $2', [idParam(req.params.id), me.id, fact]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json({ ok: true });
});

assistantRouter.delete('/api/hana/memory/:id', async (req, res) => {
  const me = self(req);
  const { rowCount } = await pool.query('DELETE FROM hana_memories WHERE id = $1 AND member_id = $2', [idParam(req.params.id), me.id]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json({ ok: true });
});

assistantRouter.delete('/api/hana/reminders/:id', async (req, res) => {
  const me = self(req);
  const { rowCount } = await pool.query('DELETE FROM hana_reminders WHERE id = $1 AND member_id = $2 AND sent_at IS NULL', [idParam(req.params.id), me.id]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json({ ok: true });
});

/** Send every reminder that's due (claimed first, so two servers can't both send). */
export async function runHanaReminders(now: Date = new Date()): Promise<number> {
  if (!pushConfigured()) return 0;
  const { rows } = await asSystem(() =>
    pool.query<{ id: number; member_id: number; household_id: number; text: string }>(
      `UPDATE hana_reminders SET sent_at = now() WHERE id IN (
         SELECT id FROM hana_reminders WHERE sent_at IS NULL AND remind_at <= $1 ORDER BY remind_at LIMIT 200 FOR UPDATE SKIP LOCKED)
       RETURNING id, member_id, household_id, text`,
      [now],
    ),
  );
  for (const r of rows) {
    await inHousehold(r.household_id, async () => {
      try {
        await sendTo(r.member_id, { title: 'Reminder', body: r.text, url: '/hana' });
      } catch (e) {
        // A reminder the gentle-copy rules reject (e.g. "don't forget…"): still remind, in neutral words.
        if (e instanceof CopyPolicyError) await sendTo(r.member_id, { title: 'Reminder', body: 'A reminder you asked Hana for — tap to see it.', url: '/hana' });
        else throw e;
      }
    });
  }
  return rows.length;
}

/** Dev/test only: run the reminder pass now (optionally "as if" at a given time). */
assistantRouter.post('/api/hana/run-reminders', async (req, res) => {
  self(req);
  if (process.env.PUSH_STUB !== '1') throw new HttpError(404, 'Not found');
  const at = typeof req.query.at === 'string' && !Number.isNaN(Date.parse(req.query.at)) ? new Date(req.query.at) : new Date();
  res.json({ sent: await runHanaReminders(at) });
});

registerJob({ name: 'hana-reminders', everyMs: 60 * 1000, run: async () => void (await runHanaReminders()) });
