# The Feed Publishing API — v1

The Feed Publishing API lets a third-party app publish to The Feed for a Feed member who connected it. It
works the way Buffer works with Instagram. The member signs in to The Feed, sees what the app is asking for,
and ticks what they allow. The app then posts as them, and every post shows **"via {app name}"**.

Rules that never change:

- **The person, and only the person.** A token acts only as the member who authorized it. There is no field
  that names another author.
- **The main Feed only.** Apps can publish to The Feed's main feed, which is 18+. They can never publish to
  Villages, Circles, stories, clips or any space a kid or teen can see. No scope allows it, and no
  parameter for it exists. Kid and teen accounts can't connect apps at all.
- **The same screening as everyone.** API posts and photos go through the exact same functions as posts
  made in The Feed. That means the same safety screening, the same holds for human review, and the same
  crisis escalation to moderators.
- **Revocable at any time.** A member can disconnect an app in **Settings → Connected apps**, and its tokens
  stop working immediately. A MyDay admin can suspend an app, which stops every one of its tokens.

## Base URLs

| | |
|---|---|
| The Feed (production host) | `https://app.thefeedsocial.com` |
| API base | `https://app.thefeedsocial.com/api/v1` |
| Consent page (browser) | `https://app.thefeedsocial.com/oauth/authorize` |
| Token endpoint | `https://app.thefeedsocial.com/api/oauth/token` |
| Revocation endpoint | `https://app.thefeedsocial.com/api/oauth/revoke` |
| Register / manage apps | `https://app.thefeedsocial.com/feed/developers` |
| Local development | `http://localhost:4000` (the API server's default `PORT`) |

The same paths also work on MyDay's own domain, since it is the same backend. A member's session is per
domain, so send people to the Feed host for consent.

## 1. Register an app

Any Feed member (18+, with a Feed profile) can register an app at **/feed/developers**, linked from
**Settings → Developers**. You give:

- **Name** (2–60 characters), shown on the consent page and on every post as "via {name}".
- **Description** and **website**, both optional and shown on the consent page.
- **Redirect URIs**, 1 to 10 of them. They must use `https`; plain `http` is allowed only for
  `localhost` / `127.0.0.1`. No `#fragment`. Matching is **exact string equality**: no prefixes and no
  extra query parameters.
- **Scopes** the app may ask for (see below).

You get a `client_id` (`feedapp_…`) and a `client_secret` (`fds_…`). **The secret is shown once.** The
Feed stores only a SHA-256 hash of it. If you lose it, choose **New secret**; the old secret stops working
immediately. Deleting an app disconnects everyone and kills its tokens. Posts it already made stay up,
still marked "via" its name.

## 2. Scopes

| Scope | What the member sees on the consent page | Lets the app |
|---|---|---|
| `profile.read` | See your Feed profile: your name and @username | `GET /me` |
| `posts.write` | Publish posts and photos to The Feed as you (they show "via" this app, and go through the same safety screening as everything else) | `POST /media`, `POST /posts`, `GET /posts/{id}`, `DELETE /posts/{id}` |

Nothing on the consent page is pre-ticked. The **Allow** button stays disabled until the member ticks at
least one scope, and they grant exactly the scopes they tick. That can be fewer than you asked for, so
read `scope` in the token response.

## 3. OAuth 2.0: authorization code (with optional PKCE)

### 3.1 Send the member to the consent page

```
GET https://app.thefeedsocial.com/oauth/authorize
    ?response_type=code
    &client_id=feedapp_0123456789abcdef01234567
    &redirect_uri=https%3A%2F%2Fyourapp.example%2Fcallback
    &scope=profile.read%20posts.write
    &state=RANDOM_PER_REQUEST
    &code_challenge=BASE64URL_SHA256_OF_VERIFIER
    &code_challenge_method=S256
```

| Parameter | |
|---|---|
| `response_type` | Required. Always `code`; no other flow exists. |
| `client_id` | Required. |
| `redirect_uri` | Required. Must exactly equal one of the app's registered URIs. |
| `scope` | Space-separated. If you leave it out, the app's registered scopes are used. You can't ask for a scope the app isn't registered for. |
| `state` | Recommended (≤ 500 characters). Returned unchanged. |
| `code_challenge`, `code_challenge_method` | Optional PKCE. `S256` only (`plain` is refused); the challenge is 43–128 base64url characters. |

If the member isn't signed in, the page asks them to sign in and comes back afterwards. The page shows:

- the app's name, description, developer and website;
- the host it will return to;
- the account being granted, as display name, @username and email, with a "Not you?" link;
- one unticked box per scope.

When the member decides:

- **Allow** sends the browser to `redirect_uri?code=fdc_…&state=…`. The code is single-use and expires
  after **10 minutes**.
- **Cancel** sends the browser to `redirect_uri?error=access_denied&error_description=…&state=…`.

**Errors.** An unknown `client_id`, an unregistered `redirect_uri` or a suspended app is shown on The
Feed's own page and **never redirected**. Other problems are sent back to your `redirect_uri` as
`error=invalid_scope`, `unsupported_response_type` or `invalid_request`, together with `state`.

### 3.2 Exchange the code for tokens

`POST /api/oauth/token` takes `application/x-www-form-urlencoded` or JSON. Authenticate the app with
HTTP Basic (`client_id:client_secret`, each form-URL-encoded), or send `client_id` and `client_secret` in
the body.

```bash
curl -s https://app.thefeedsocial.com/api/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=authorization_code \
  -d code="$CODE" \
  -d redirect_uri=https://yourapp.example/callback \
  -d code_verifier="$VERIFIER"
```

```json
{
  "access_token": "fda_…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "fdr_…",
  "refresh_token_expires_in": 2592000,
  "scope": "profile.read posts.write"
}
```

- `redirect_uri` must be the same one used on the consent page.
- If you sent a `code_challenge`, `code_verifier` is required.
- **Replaying a used code fails, and it also revokes every token that code produced.**

### 3.3 Refresh, with rotation

```bash
curl -s https://app.thefeedsocial.com/api/oauth/token -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=refresh_token -d refresh_token="$REFRESH_TOKEN"
```

- Each refresh returns a **new access token and a new refresh token**. The refresh token you sent is
  spent: **using it again fails, and also revokes everything issued from it since (the whole grant)**, on
  the assumption it leaked. Always store the newest refresh token.
- An optional `scope` can keep or narrow the granted scopes, never widen them.

### 3.4 Revoke

```bash
curl -s https://app.thefeedsocial.com/api/oauth/revoke -u "$CLIENT_ID:$CLIENT_SECRET" -d token="$TOKEN"
```

This follows RFC 7009:

- An access token is revoked on its own.
- A refresh token is revoked together with its whole grant.
- The response is always `200 {}`, even for an unknown token.

### 3.5 Lifetimes

| | Lifetime | Stored as |
|---|---|---|
| Authorization code | 10 minutes, single use | SHA-256 hash |
| Access token | 1 hour | SHA-256 hash |
| Refresh token | 30 days, single use (rotates) | SHA-256 hash |

### 3.6 What ends a token early

- The member disconnects the app in **Settings → Connected apps**.
- The app revokes the token.
- A spent refresh token is reused.
- An admin suspends the app. Suspension revokes all its tokens, and the app status is also checked on
  every API call. A reactivated app's members must connect it again.
- The app is deleted.
- The member's account is removed.

## 4. Calling the API

Send the access token as `Authorization: Bearer fda_…`. Cookies are ignored on `/api/v1`: a browser
session is not an API credential.

### `GET /api/v1/me` (`profile.read`)

```bash
curl -s https://app.thefeedsocial.com/api/v1/me -H "Authorization: Bearer $ACCESS_TOKEN"
```

```json
{ "id": 42, "displayName": "Pat", "username": "pat_posts", "profileUrl": "https://app.thefeedsocial.com/u/pat_posts" }
```

### `POST /api/v1/media` (`posts.write`): upload one photo

The body is the photo's raw bytes, and `Content-Type` is the photo's type. JPEG, PNG and WebP are
accepted, up to **8 MB**. The photo is screened on upload, just like a photo added in The Feed.

```bash
curl -s https://app.thefeedsocial.com/api/v1/media \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: image/jpeg" \
  --data-binary @desk.jpg
```

```json
{ "id": 913, "status": "ready" }
```

`status` is either `ready`, or `held` (under review). A post with a held photo is itself held until a
moderator decides. Video gets `415 unsupported_media`: Feed posts carry photos only (see §9).

### `POST /api/v1/posts` (`posts.write`): publish

```bash
curl -s https://app.thefeedsocial.com/api/v1/posts \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"text": "Desk, finally cleared.", "mediaIds": [913]}'
```

| Field | |
|---|---|
| `text` | Up to 2000 characters. Optional if there's a photo. |
| `mediaIds` | Optional. At most **one** id, and it must come from `POST /media` by **this app for this member**. |
| `audience` | Optional, `"public"` or `"friends"`. If you leave it out, the member's default audience is used. |

Any other field gets `400 unknown_field`. A field naming another place to post gets
`403 surface_not_allowed`, and nothing is saved. Those fields are `village`, `villageId`, `circle`,
`circleId`, `thread`, `forum`, `surface`, `kid`, `kids`, `teen`, `household`, `member`, `group`, `story`
and `clip`.

Response (`201`):

```json
{
  "post": {
    "id": 5120,
    "status": "published",
    "text": "Desk, finally cleared.",
    "mediaIds": [913],
    "audience": "public",
    "createdAt": "2026-10-13T15:04:05.000Z",
    "url": "https://app.thefeedsocial.com/feed/post/5120",
    "via": { "appId": 7, "name": "Scheduler A" }
  }
}
```

### `GET /api/v1/posts/{id}` (`posts.write`): read status

This returns the same `post` object. It works only for a post **this app made for this member**. Anything
else (another app's post, another member's post, a post made in The Feed itself) is `404 not_found`.

### `DELETE /api/v1/posts/{id}` (`posts.write`)

This removes a post this app made for this member and returns `{"ok": true}`. Afterwards, `GET` shows
`"status": "removed"`. The member can always delete it in The Feed as well.

## 5. Statuses, and the screening gate

| `status` | Meaning |
|---|---|
| `published` | On The Feed. |
| `held` | Waiting for a human. Either safety screening held it, or member reports took it down until a moderator decides. Nobody else can see it. |
| `removed` | Deleted by the app or the member, or removed by a moderator. |

Screening runs **before** `POST /posts` responds, so a post is never left in a "screening" state. You get
one of these:

- `published`;
- `held`;
- or `422 blocked`, when the text tells other people to start, stop or change a medication or dose. In
  that case **nothing is saved**, and `details.rephrase` says how to say it instead.

A held post changes to `published` or `removed` when a moderator decides, so poll `GET /posts/{id}`.

Screening reasons are **not** shared with apps. If a post is held because someone may be in danger, the
member sees crisis resources (988) in The Feed, and the moderators are alerted. The app only ever sees
`held`.

## 6. "via" attribution

Every API post shows **"via {app name}"** next to its time on The Feed. Moderators see the same thing in
their queue.

- The name is the app's current name.
- If the app is later deleted, the name it had when it posted is kept.
- Posts made in The Feed itself have no "via".

## 7. Errors

**Publishing API (`/api/v1`)** uses The Feed's usual shape:

```json
{ "error": "A human-readable sentence", "code": "machine_readable", "details": { } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `unknown_field`, `empty_post`, `text_too_long`, `invalid_text`, `invalid_media`, `too_many_media`, `unknown_media`, `invalid_audience`, `empty_media`, `unsupported_media` | Bad request |
| 401 | `missing_token`, `invalid_token`, `app_suspended` | Also sent with `WWW-Authenticate: Bearer realm="The Feed", error="invalid_token"` |
| 403 | `insufficient_scope` | The token lacks the scope (`WWW-Authenticate` names it) |
| 403 | `surface_not_allowed` | The request tried to post anywhere but the main Feed |
| 403 | `adults_only`, `banned`, `muted` | The Feed's own member rules |
| 404 | `not_found` | Unknown post or endpoint |
| 409 | `no_profile` | The member has no Feed profile yet |
| 413 | — | Photo over 8 MB |
| 415 | `unsupported_media` | Video |
| 422 | `blocked` | Screening refused the words (see §5); `details.rephrase` |
| 429 | `rate_limited` | Over an API quota (§8); `details.quota` |
| 429 | `post_limit` | Over The Feed's own 30-posts-an-hour limit for any member |

**OAuth endpoints** (`/api/oauth/token`, `/api/oauth/revoke`) use RFC 6749 §5.2:
`{"error": "invalid_grant", "error_description": "…"}`, with `error` being one of `invalid_request`,
`invalid_client` (401), `invalid_grant`, `invalid_scope`, `unsupported_grant_type` or `slow_down` (429).
Token responses are sent with `Cache-Control: no-store`.

## 8. Rate limits

The quotas are counted over a rolling window from what was actually stored, so they hold across server
restarts. They are set in one place, `api/src/lib/feedapi-limits.ts`, and operators can override them
with `FEED_API_LIMITS`.

| Quota | Default |
|---|---|
| Posts per app (everyone using it) | 500 per hour |
| Posts per member (all apps together) | 20 per hour |
| Photos per app | 500 per hour |
| Photos per member (all apps together) | 40 per hour |

`POST /posts` and `POST /media` return these headers for whichever quota is closer to running out:

```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 17        (after this request)
X-RateLimit-Reset: 1792000000    (Unix seconds, when the oldest counted item leaves the window)
```

Going over a quota returns `429 rate_limited`, `Retry-After: <seconds>`, and
`details: {"quota": "posts.user", "limit": 20, "windowSeconds": 3600}`. Nothing is stored. The Feed's own
limit also applies to every member, app or not: **30 posts an hour across every kind of post**
(`429 post_limit`). The token endpoint allows 120 requests per minute per client and IP.

## 9. What v1 doesn't do (and why)

- **No video.** Video in The Feed exists only for Clips, which aren't screened the way posts and photos
  are. Rather than open an unscreened path, v1 refuses video with `415`.
- **One photo per post.** That is how The Feed's posts work.
- **No polls, feelings, places or comment settings.** Posts get the defaults; these may come later as
  additive v1 fields.
- **No reading other people's posts, feeds, messages or followers.** v1 is publishing only.
- **No "screening" status.** Screening finishes before the response (§5).

## 10. Versioning

This is **v1**, under `/api/v1`.

- v1 only ever **adds**: new optional request fields, new response fields and new endpoints. Ignore
  response fields you don't know.
- Anything breaking goes under **`/api/v2`**, and v1 keeps working alongside it. Breaking means removing
  or renaming a field, changing a meaning or a default, making something required, or tightening
  validation of a field you could already send.
- Unknown request fields are refused today (`400 unknown_field`). That way a field added later can never
  be silently ignored by an older server.

## 11. Run the end-to-end demo

`scripts/feed-api-demo.mjs` is a plain-`fetch` client that runs this whole contract:

1. authorize, with PKCE;
2. exchange the code for tokens, then call `/me`;
3. publish a text post;
4. upload a photo and publish it;
5. check that other surfaces are refused;
6. read the post's status;
7. refresh, with rotation;
8. delete the post;
9. show that a spent refresh token is refused and ends the grant.

It prints `DEMO PASSED` only if every step returned what this document says.

```bash
# Against any server, as a real app (register it first with this exact redirect URI). You click Allow.
FEED_API_BASE=https://app.thefeedsocial.com \
FEED_CLIENT_ID=feedapp_… FEED_CLIENT_SECRET=fds_… \
FEED_REDIRECT_URI=http://localhost:8765/callback \
node scripts/feed-api-demo.mjs

# Against a local/test server: no person needed (uses the dev-only sign-in, which production doesn't have).
FEED_API_BASE=http://localhost:4000 FEED_DEMO_DEV_TOKEN=<that server's DEV_LOGIN_TOKEN> node scripts/feed-api-demo.mjs
```

The test gate runs the demo against a live test server on every run. The Publishing API tests are
`publishingApiSuite` in `scripts/e2e.mjs`:
`E2E_ONLY=publishingApiSuite node scripts/e2e.mjs`.
