/**
 * Feature routers added in the big build. Each module owns its router; this
 * list is the only place they're registered.
 */
import type { Router } from 'express';
import { accountRouter } from './account.js';
import { adminRouter, billingRouter, billingWebhookRouter } from './billing.js';
import { billsRouter } from './bills.js';
import { careRouter, proRouter } from './care.js';
import { assistantRouter } from './assistant.js';
import { errandsRouter } from './errands.js';
import { grocersRouter } from './grocers.js';
import { inboundRouter, inboxRouter } from './inbox.js';
import { calendarFeedRouter, calendarRouter } from './calendar.js';
import { circlesRouter, circlesStaffRouter } from './circles.js';
import { communityRouter, communityStaffRouter, communityUploadRouter } from './community.js';
import { engagementRouter } from './engagement.js';
import { identityRouter } from './identity.js';
import { joinRouter } from './join.js';
import { investRouter } from './invest.js';
import { kidMoneyRouter } from './kidmoney.js';
import { chatFilesRouter, chatUploadRouter } from './chatFiles.js';
import { lecturesRouter, lectureUploadRouter } from './lectures.js';
import { meetingsRouter, meetingUploadRouter } from './meetings.js';
import { notificationsRouter } from './notifications.js';
import { photosRouter, photoUploadRouter } from './photos.js';
import { programRouter } from './program.js';
import { appleCallbackRouter } from './signin.js';
import { recordsRouter } from './records.js';
import { schoolRouter } from './school.js';

export const extraRouters: Router[] = [programRouter, schoolRouter, lecturesRouter, identityRouter, billsRouter, kidMoneyRouter, engagementRouter,
  notificationsRouter, recordsRouter, billingRouter, investRouter, circlesRouter, careRouter, photosRouter, accountRouter, communityRouter, calendarRouter, assistantRouter, inboxRouter, grocersRouter, errandsRouter, meetingsRouter, chatFilesRouter];

/** Routes that work before the household gate (staff/admin, no household of their own needed). */
export const preHouseholdRouters: Router[] = [adminRouter, circlesStaffRouter, communityStaffRouter, proRouter, joinRouter];

/** Public, outside /api and sign-in: the calendar subscription feed (its secret is in the URL). */
export const publicRoutes: Router[] = [calendarFeedRouter, inboundRouter];

/** Routes that take raw (non-JSON) bodies, mounted before the JSON parser. */
export const uploadRoutes: Router[] = [lectureUploadRouter, meetingUploadRouter, chatUploadRouter, photoUploadRouter, communityUploadRouter, billingWebhookRouter, appleCallbackRouter];
