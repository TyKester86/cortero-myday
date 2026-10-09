function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  production: opt('NODE_ENV') === 'production',
  port: Number(opt('PORT', '4000')),
  tz: opt('TZ_HOUSEHOLD', 'America/Chicago'),
  publicUrl: opt('PUBLIC_URL', 'http://localhost:5173').replace(/\/$/, ''),
  /** The Feed's own app (its own domain, same server and database). Empty: no separate Feed app. */
  feedAppUrl: opt('FEED_APP_URL', opt('NODE_ENV') === 'production' ? 'https://thefeedsocial.com' : '').replace(/\/$/, ''),
  databaseUrl: req('DATABASE_URL'),
  /** Checked at server start (not here) so `migrate` runs without it. */
  sessionSecret: opt('SESSION_SECRET'),
  googleClientId: opt('GOOGLE_CLIENT_ID'),
  googleClientSecret: opt('GOOGLE_CLIENT_SECRET'),
  allowedEmails: opt('ALLOWED_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  /** New Google accounts may sign up and create a household (SIGNUP_OPEN=false: roster emails only). */
  signupOpen: opt('SIGNUP_OPEN', 'true') !== 'false',
  /** MyDay staff who may open the admin dashboard (comma-separated emails). */
  adminEmails: opt('ADMIN_EMAILS', '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  /** Payment provider: none (default — payments not live) | stub (test card, never charges) | stripe (real). */
  billingProvider: (['stub', 'stripe'].includes(opt('BILLING_PROVIDER', 'none')) ? opt('BILLING_PROVIDER') : 'none') as 'none' | 'stub' | 'stripe',
  /** TEMPORARY verification backdoor. Empty = disabled (the default). */
  devLoginToken: opt('DEV_LOGIN_TOKEN'),
};
