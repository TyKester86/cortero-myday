import type { Request } from 'express';
import { config } from '../config.js';

const feedHost = config.feedAppUrl ? new URL(config.feedAppUrl).hostname : null;

/** Is this request on the Feed's own domain (the standalone Feed app)? Same server, same database. */
export const onFeedApp = (req: Request): boolean => !!feedHost && req.hostname === feedHost && feedHost !== new URL(config.publicUrl).hostname;

/** This request's own public address: the Feed app's, or MyDay's. Links sent from here point back to it. */
export const originFor = (req: Request): string => (onFeedApp(req) ? config.feedAppUrl : config.publicUrl);
