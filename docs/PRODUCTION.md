# Going to production

Staging (`staging.conquermyday.app`) shares a server and a database with Opsentra, which is fine for testing but not for paying customers. Production gets its own server and its own database. The files are in `deploy/production/`, and the manual deploy is `.github/workflows/deploy-production.yml`.

## What you need to set up (once)

**Server and access**
1. **A server.** A DigitalOcean droplet with 2 GB RAM and 1 vCPU is enough to start. Install Docker on it. Point `conquermyday.app` (and `www`) at it; Caddy gets HTTPS certificates automatically.
2. **GitHub secrets:** `PROD_HOST` (the server IP) and `PROD_SSH_KEY` (a deploy key for that server only). Optionally, add a GitHub *environment* named `production` with you as the required reviewer.

**Configuration**
3. **`/opt/myday-prod/deploy/production/.env`.** Copy it from `deploy/production/env.example` and `chmod 600` it. Generate secrets with `openssl rand -hex 32`, and keep copies of `SESSION_SECRET`, `MONEY_TOKEN_KEY` and `PHOTO_KEY` in your password manager. Losing them makes saved bank links and progress photos unreadable.
4. **The app's database role.** Create it the way `deploy/bootstrap-droplet.sh` does: a `myday` role that owns the `myday` database, NOT a superuser, so row-level security is always enforced.

**Outside services**
5. **Stripe.** Set the plan price in the admin dashboard, then put the secret key in `STRIPE_SECRET_KEY`. Add a webhook endpoint `https://conquermyday.app/api/billing/webhook` for these events:
   - `checkout.session.completed`
   - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`
   - `invoice.payment_failed`

   Put its signing secret in `STRIPE_WEBHOOK_SECRET`. Turn on the customer portal, and email receipts in Stripe's settings.
6. **Email (Resend).** Verify the `conquermyday.app` domain and put the key in `RESEND_API_KEY`. This turns on email sign-in links, invites and trial reminders.
7. **Sign in with Apple** (optional). Create a Services ID with return URL `https://conquermyday.app/api/auth/apple/callback` and set `APPLE_CLIENT_ID`.
8. **Monitoring.**
   - Create a Sentry project and set `SENTRY_DSN`, and/or set a Slack/Discord webhook as `ERROR_WEBHOOK_URL`.
   - Add an uptime check (UptimeRobot, Better Stack…) on `https://conquermyday.app/api/health/deep`, which also checks the database.

**Backups**
9. **Set them up** as in `docs/BACKUP-RESTORE.md`: a nightly cron for `deploy/backup.sh` with off-server storage, plus a monthly restore drill.

## Deploying

Run **Actions → Deploy to production → Run workflow** and type `production` to confirm. Each deploy:
- snapshots the current release,
- backs up the database,
- rebuilds the app and runs migrations,
- refuses to report success until `/api/health/deep` answers.

Staging keeps deploying on every push to `main`, so changes always land there first.

## Never in production

- `DEV_LOGIN_TOKEN`: a testing backdoor. The server warns at start if it's set.
- `CHAT_STUB`, `TRANSCRIPTION_STUB`, `MONEY_PROVIDER=fake`, `MAIL_PROVIDER=stub`: these are test doubles, and the server ignores them in production anyway.

## Paperwork that takes weeks (start early)

- **Google sign-in verification.** The Classroom permission is a "sensitive scope", so Google reviews the app before the public can use it. You need the privacy policy URL (`/privacy`), a verified domain and a short video.
- **Plaid production access.** Plaid's security questionnaire and use-case review.
- **Legal review.** Have a lawyer review `/privacy` and `/terms`, the parental-consent flow for kids under 13 (COPPA), and recording-consent wording for classrooms.
