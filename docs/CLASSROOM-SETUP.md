# Google Classroom import — setup

MyDay reuses the Google sign-in client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). Two console steps, once:

1. **Add the redirect URI.** Google Cloud Console → *APIs & Services* → *Credentials* → open the OAuth 2.0 Client ID MyDay uses for sign-in → *Authorized redirect URIs* → **Add URI**:
   - Staging: `https://staging.conquermyday.app/api/classroom/callback`
   - (Production later: `https://<prod host>/api/classroom/callback`)

   It must equal `<PUBLIC_URL>/api/classroom/callback` exactly (scheme, host, no trailing slash). Click **Save**; changes can take a few minutes.
2. **Enable the API.** *APIs & Services* → *Library* → search **Google Classroom API** → **Enable**.
3. **Consent screen.** *OAuth consent screen* → *Data access* (Scopes) → add `https://www.googleapis.com/auth/classroom.courses.readonly`. While the app is in *Testing*, add each parent/student Google account under *Test users*.

Nothing to restart: the next "Connect Google Classroom" tap on the School page uses it. MyDay only reads the course list; the access token is used once and never stored.
