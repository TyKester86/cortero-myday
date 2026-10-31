/**
 * JP2 routes: connect your own Messages to Hana (grown-ups; off by default), and the kids'
 * safety-signal settings (parents set; the kid sees it and is told; off by default).
 */
import { Router } from 'express';
import { idParam } from '../lib/http.js';
import { listMembers, self } from '../lib/members.js';
import { connected, inboxFor, kidSafety, setConnected, setKidSafety } from '../lib/chief/messaging.js';

export const messagingRouter = Router();

messagingRouter.get('/api/messages/hana', async (req, res) => {
  const me = self(req);
  if (me.kind !== 'adult') {
    res.json({ connected: false, inbox: [], kids: [], mine: await kidSafety(me.id) });
    return;
  }
  const kids = (await listMembers()).filter((m) => m.kind === 'kid');
  res.json({ connected: await connected(me.id), inbox: await inboxFor(me), kids: await Promise.all(kids.map((k) => kidSafety(k.id))), mine: null });
});

messagingRouter.put('/api/messages/hana', async (req, res) => {
  const me = self(req);
  await setConnected(me, (req.body as { connected?: unknown }).connected === true);
  res.json({ connected: await connected(me.id) });
});

messagingRouter.put('/api/messages/kid-safety/:kidId', async (req, res) => {
  res.json({ safety: await setKidSafety(self(req), idParam(req.params.kidId), (req.body as { on?: unknown }).on === true) });
});
