/**
 * The Feed Publishing API, v1 (https://app.thefeedsocial.com/api/v1). Every call authenticates with a
 * bearer access token (routes/oauth.ts `bearer`) and acts as the person who authorized the app -- never
 * anyone else. Breaking changes go under /api/v2; v1 only ever gains fields and endpoints.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { member } from './community.js';
import { bearer, needScope } from './oauth.js';

export const feedApiV1Router = Router();

feedApiV1Router.use('/api/v1', bearer);

/** profile.read: who the token acts for. */
feedApiV1Router.get('/api/v1/me', async (req, res) => {
  needScope(req, res, 'profile.read');
  const m = await member(req);
  res.json({
    id: m.userId,
    displayName: m.profile.display_name,
    username: m.profile.username,
    profileUrl: m.profile.username && config.feedAppUrl ? `${config.feedAppUrl}/u/${m.profile.username}` : null,
  });
});

// Nothing else lives under /api/v1: an unknown path stops here (it never reaches the session routes).
feedApiV1Router.use('/api/v1', () => {
  throw new HttpError(404, 'No such endpoint in the Feed API v1', 'not_found');
});
