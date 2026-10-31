/**
 * JP3 routes: the house (parents) and storm mode (everyone — a kid gets the shelter steps only).
 */
import { Router } from 'express';
import { HttpError, str } from '../lib/http.js';
import { self } from '../lib/members.js';
import { viewerOf } from '../lib/chief/scope.js';
import { connectHouse, disconnectHouse, houseStatus, place, requireParentHouse, setPlace, stormPlan, syncWeather } from '../lib/chief/house.js';

export const houseRouter = Router();

houseRouter.get('/api/house', async (req, res) => {
  const me = self(req);
  requireParentHouse(me);
  await syncWeather();
  res.json({ status: await houseStatus(), place: await place(), storm: await stormPlan(viewerOf(me)) });
});

houseRouter.post('/api/house/connect', async (req, res) => {
  const b = req.body as { url?: unknown; token?: unknown };
  await connectHouse(self(req), str(b.url, 'url', 300, true), str(b.token, 'token', 1000, true));
  res.status(201).json({ status: await houseStatus() });
});

houseRouter.delete('/api/house/connection', async (req, res) => {
  await disconnectHouse(self(req));
  res.json({ status: await houseStatus() });
});

houseRouter.put('/api/house/place', async (req, res) => {
  const b = req.body as { lat?: unknown; lon?: unknown; label?: unknown; weatherOn?: unknown };
  const lat = Number(b.lat);
  const lon = Number(b.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new HttpError(400, 'Give a latitude and longitude');
  await setPlace(self(req), lat, lon, typeof b.label === 'string' ? b.label : 'Home', b.weatherOn !== false);
  res.json({ place: await place() });
});

/** Storm mode for anyone in the family; a kid's view carries the steps, never the house. */
houseRouter.get('/api/storm', async (req, res) => {
  const v = viewerOf(self(req));
  const p = await stormPlan(v);
  res.json({ storm: p && !v.parent ? { ...p, out: [], decisions: [], house: [] } : p });
});
