# Going to production

Staging (`staging.conquermyday.app`) shares a server and a database with Opsentra, which is fine for testing but not for paying customers. Production gets its own server and its own database. The files are in `deploy/production/`, and the manual deploy is `.github/workflows/deploy-production.yml`.

## What you need to set up (once)

**Server and access**
1. **A server.** A DigitalOcean droplet with 2 GB RAM and 1 vCPU is enough to start. Install Docker on it. Point `conquermyday.app` (and `www`) at it; Caddy gets HTTPS certificates automatically.
2. **GitHub secrets:** `PROD_HOST` (the server IP) and `PROD_SSH_KEY` (a deploy key for that server only). Optionally, add a GitHub *environment* named `production` with you as the required reviewer.

**Configuration**
3. **`/opt/myday-prod/deploy/production/.env`.** Copy it from `deploy/production/env.example` and `chmod 600` it. Generate secrets with `openssl rand -hex 32`, and keep copies of `SESSION_SECRET`, `MONEY_TOKEN_KEY`, `PHOTO_KEY` and `CONTENT_KEY` in your password manager. Losing them makes saved bank links, progress photos and community posts unreadable.
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

**Community (The Village + The Feed)**
9a. **Moderators** are the MyDay admins (`ADMIN_EMAILS`). They get an email when a post may involve someone in danger, and work the queue at `/community/moderation`.
9b. **The pre-screen** uses `ANTHROPIC_KEY`. Without it, production holds every post for a moderator, so the screen never silently lets things through.
9c. **Legal**: the community sections of `/privacy` and `/terms` (adults-only, no medical advice, the license for what people post, moderation rights) need a lawyer's review before launch.

**Hana: push and "Forward to Hana" email**
10. **Push notifications**: set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (generate once with `npx web-push generate-vapid-keys`; keep the private key in the password manager — changing it means everyone re-enables notifications). iPhone users must add MyDay to the Home Screen first; Settings shows a hint.
11. **Forward to Hana**: pick an inbound-email service (Postmark Inbound is the simplest; Cloudflare Email Routing + a small Worker is free).
    - DNS: an MX record for `in.conquermyday.app` pointing at the service.
    - Webhook: `https://conquermyday.app/inbound/email?key=<INBOUND_SECRET>` (JSON). Postmark, Resend inbound and a plain `{from,to,subject,text,html}` body are all understood.
    - Set `INBOUND_DOMAIN` and a long random `INBOUND_SECRET` (`openssl rand -hex 24`). Without `INBOUND_SECRET` the webhook is off.
12. **Grocery ordering** (Grocery list → Order it, or "order the groceries" to Hana). MyDay only builds the list or fills the cart; people always check out and pay on the store's site.
    - **Instacart**: apply for the Instacart Developer Platform (shopping-list links), then set `INSTACART_API_KEY`. `INSTACART_BASE_URL` defaults to `https://connect.instacart.com` (use their dev URL while testing).
    - **Kroger** (also Ralphs, Fred Meyer, King Soopers, etc.): create an app at developer.kroger.com with the `cart.basic:write` and `product.compact` scopes; redirect URI `https://conquermyday.app/api/grocery/kroger/callback`. Set `KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET`. Each grown-up connects their own account on Kroger's sign-in page (MyDay never sees the password); tokens are encrypted at rest.
    - With neither set, the Order it card simply doesn't show.
13. **Flight search** ("find flights to Denver the weekend of the 14th" to Hana). Hana always gives filled-in Google Flights and Kayak links; with `DUFFEL_API_KEY` (duffel.com, a live-mode access token) she also reads real prices, airlines, stops and times. She never books or pays.

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
