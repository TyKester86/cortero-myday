/**
 * JP4 routes: location sharing — consent first. Everyone can see their own settings and exactly
 * who sees them; a grown-up sets their own, the parents set a kid's; only your own device reports
 * where you are; history is yours (and your parents', for a kid) to see and delete.
 */
import { Router } from 'express';
import { HttpError, idParam } from '../lib/http.js';
import { listMembers, self } from '../lib/members.js';
import { forgetHistory, history, ping, seenBy, setSharing, settingsFor } from '../lib/chief/location.js';

export const locationRouter = Router();

/** Mine: my settings (who sees me), what I can see, and — for a parent — each kid's settings. */
locationRouter.get('/api/location', async (req, res) => {
  const me = self(req);
  const kids = me.kind === 'adult' ? (await listMembers()).filter((m) => m.kind === 'kid') : [];
  res.json({ mine: await settingsFor(me.id), seen: await seenBy(me), kids: await Promise.all(kids.map((k) => settingsFor(k.id))) });
});

locationRouter.put('/api/location/settings/:memberId', async (req, res) => {
  const b = req.body as { sharing?: unknown; viewers?: unknown; keepDays?: unknown };
  const viewers = Array.isArray(b.viewers) ? b.viewers : [];
  if (!viewers.every((x) => Number.isInteger(x))) throw new HttpError(400, 'viewers are member ids');
  res.json({ settings: await setSharing(self(req), idParam(req.params.memberId), b.sharing === true, viewers as number[], b.keepDays === undefined ? 7 : Number(b.keepDays)) });
});

/** The member's own device reports in (only while their sharing is on). */
locationRouter.post('/api/location/ping', async (req, res) => {
  const b = req.body as { lat?: unknown; lon?: unknown; accuracy?: unknown };
  const lat = Number(b.lat);
  const lon = Number(b.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new HttpError(400, 'Give a latitude and longitude');
  res.json(await ping(self(req), lat, lon, Number.isFinite(Number(b.accuracy)) ? Number(b.accuracy) : null));
});

locationRouter.get('/api/location/history/:memberId', async (req, res) => {
  res.json({ points: await history(self(req), idParam(req.params.memberId)) });
});

locationRouter.delete('/api/location/history/:memberId', async (req, res) => {
  res.json({ forgotten: await forgetHistory(self(req), idParam(req.params.memberId), null) });
});

locationRouter.delete('/api/location/history/:memberId/:pointId', async (req, res) => {
  res.json({ forgotten: await forgetHistory(self(req), idParam(req.params.memberId), idParam(req.params.pointId)) });
});
