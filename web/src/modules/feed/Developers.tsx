/**
 * The Feed Publishing API, from the app side:
 *   /feed/developers  -- register and manage your apps (client_id, the once-shown secret); admins also see
 *                        every app and can suspend or reactivate it.
 * and from the person's side:
 *   /oauth/authorize     -- the consent page (nothing pre-ticked; Allow or Cancel goes back to the app)
 *   /feed/settings/apps  -- Connected apps: disconnect any app, effective immediately.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { FEED_API_SCOPES, FEED_API_SCOPE_LABELS, type CommunityMe, type FeedApiApp, type FeedApiAppCreated, type FeedApiScope, type FeedConnectedApp } from '@myday/shared';
import { ApiFail, api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { FeedHorn } from '../../components/NavIcon';
import { signOut } from '../../signout';
import { Gate } from '../community/Community';
import { TopBar, errText } from './kit';

export function DevelopersPage() {
  return (
    <section className="sc-page feed-page" data-testid="developers-page">
      <TopBar title="Developers" />
      <Gate>{(me) => <Developers me={me} />}</Gate>
    </section>
  );
}

interface Draft {
  name: string;
  description: string;
  website: string;
  redirectUris: string;
  scopes: FeedApiScope[];
}
const EMPTY: Draft = { name: '', description: '', website: '', redirectUris: '', scopes: [] };

function Developers({ me }: { me: CommunityMe }) {
  const { data, error, reload } = useLoad<{ apps: FeedApiApp[] }>('/api/developer/apps');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secret, setSecret] = useState<FeedApiAppCreated | null>(null);
  const [msg, setMsg] = useState('');
  const confirm = useConfirm();

  const register = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setMsg('');
    try {
      const out = await api<FeedApiAppCreated>('/api/developer/apps', 'POST', { ...draft, redirectUris: draft.redirectUris.split(/\s+/).filter(Boolean) });
      setSecret(out);
      setDraft(null);
      reload();
    } catch (err) {
      setMsg(errText(err, 'Couldn’t register the app'));
    }
  };
  const rotate = async (a: FeedApiApp) => {
    if (!(await confirm({ title: `New secret for ${a.name}?`, body: 'The current secret stops working right away. Tokens already issued keep working.', confirmLabel: 'Make a new secret', danger: true }))) return;
    try {
      setSecret(await api<FeedApiAppCreated>(`/api/developer/apps/${a.id}/secret`, 'POST', {}));
    } catch (err) {
      setMsg(errText(err, 'Couldn’t rotate the secret'));
    }
  };
  const remove = async (a: FeedApiApp) => {
    if (!(await confirm({ title: `Delete ${a.name}?`, body: 'Every person who connected it is disconnected and its tokens stop working. Posts it already made stay up.', confirmLabel: 'Delete app', danger: true }))) return;
    try {
      await api(`/api/developer/apps/${a.id}`, 'DELETE');
      reload();
    } catch (err) {
      setMsg(errText(err, 'Couldn’t delete the app'));
    }
  };

  return (
    <>
      <section className="sc-card sc-note">
        <p>
          Build an app that publishes to The Feed for people who connect it. Every post goes through the same safety screening as posts made here, and shows “via” your app’s name. Apps can only
          post to the main Feed — never to any kids’ space. The API is described in <code>docs/feed-api.md</code>.
        </p>
      </section>
      {msg && (
        <p className="sc-toast" role="alert">
          {msg}
        </p>
      )}
      {secret && (
        <section className="sc-card sc-note" data-testid="dev-secret">
          <h2 className="sc-h3">{secret.app.name}: copy your client secret now</h2>
          <p className="sc-meta">This is the only time it’s shown. We store only a fingerprint of it, so it can’t be shown again — if you lose it, make a new one.</p>
          <ul className="sc-details">
            <li>
              <span>client_id</span> <code data-testid="dev-client-id">{secret.app.clientId}</code>
            </li>
            <li>
              <span>client_secret</span> <code data-testid="dev-client-secret">{secret.clientSecret}</code>
            </li>
          </ul>
          <button type="button" className="sc-btn small" onClick={() => setSecret(null)} data-testid="dev-secret-done">
            I’ve saved it
          </button>
        </section>
      )}

      <h2 className="sc-h3">Your apps</h2>
      {error && <p className="error">{error}</p>}
      {!data ? (
        <p className="sc-meta">Loading…</p>
      ) : data.apps.length === 0 && !draft ? (
        <p className="sc-meta">No apps yet.</p>
      ) : (
        data.apps.map((a) => (
          <section key={a.id} className="sc-card sc-note" data-testid="dev-app" data-status={a.status}>
            <h3 className="sc-h3">{a.name}</h3>
            {a.status === 'suspended' && (
              <p className="sc-toast" role="status">
                Suspended{a.suspendedReason ? `: ${a.suspendedReason}` : ''}. Its tokens no longer work.
              </p>
            )}
            {a.description && <p>{a.description}</p>}
            <ul className="sc-details">
              <li>
                <span>client_id</span> <code>{a.clientId}</code>
              </li>
              <li>
                <span>Scopes</span> <b>{a.scopes.join(', ')}</b>
              </li>
              <li>
                <span>Redirect URIs</span> <b>{a.redirectUris.join(' · ')}</b>
              </li>
              <li>
                <span>Connected people</span> <b>{a.users}</b>
              </li>
            </ul>
            <div className="sc-actions">
              <button type="button" className="sc-btn small ghost" onClick={() => void rotate(a)} data-testid="dev-rotate">
                New secret
              </button>
              <button type="button" className="sc-link danger" onClick={() => void remove(a)} data-testid="dev-delete">
                Delete
              </button>
            </div>
          </section>
        ))
      )}

      {draft ? (
        <form className="sc-card sc-form" onSubmit={(e) => void register(e)} data-testid="dev-register">
          <label>
            <span>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required minLength={2} maxLength={60} data-testid="dev-name" />
          </label>
          <label>
            <span>Description</span>
            <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={500} rows={2} placeholder="What it does, shown on the consent screen" data-testid="dev-description" />
          </label>
          <label>
            <span>Website</span>
            <input type="url" value={draft.website} onChange={(e) => setDraft({ ...draft, website: e.target.value })} maxLength={300} placeholder="https://" data-testid="dev-website" />
          </label>
          <label>
            <span>Redirect URIs</span>
            <textarea
              value={draft.redirectUris}
              onChange={(e) => setDraft({ ...draft, redirectUris: e.target.value })}
              rows={2}
              required
              placeholder="One per line. Matched exactly. https (http only for localhost)."
              autoCapitalize="none"
              data-testid="dev-redirects"
            />
          </label>
          <fieldset className="sc-form-row" style={{ border: 0, padding: 0, display: 'grid', gap: 8 }}>
            <legend>Scopes it may ask for</legend>
            {FEED_API_SCOPES.map((s) => (
              <label key={s} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={draft.scopes.includes(s)}
                  onChange={(e) => setDraft({ ...draft, scopes: e.target.checked ? [...draft.scopes, s] : draft.scopes.filter((x) => x !== s) })}
                  data-testid={`dev-scope-${s}`}
                />
                <span>
                  <code>{s}</code> — {FEED_API_SCOPE_LABELS[s]}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="sc-actions">
            <button type="submit" className="sc-btn small" data-testid="dev-register-submit">
              Register app
            </button>
            <button type="button" className="sc-btn small ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="sc-btn" onClick={() => setDraft(EMPTY)} data-testid="dev-new">
          Register an app
        </button>
      )}

      {me.isModerator && <AdminApps />}
    </>
  );
}

/** Every registered app, for MyDay admins: suspend (kills its tokens at once) or reactivate. */
function AdminApps() {
  const { data, reload } = useLoad<{ apps: FeedApiApp[] }>('/api/admin/feed-api/apps');
  const [reason, setReason] = useState('');
  const confirm = useConfirm();
  const act = async (a: FeedApiApp, what: 'suspend' | 'reactivate') => {
    if (what === 'suspend' && !(await confirm({ title: `Suspend ${a.name}?`, body: 'Every token it holds stops working immediately. People must connect it again after it’s reactivated.', confirmLabel: 'Suspend', danger: true })))
      return;
    await api(`/api/admin/feed-api/apps/${a.id}/${what}`, 'POST', what === 'suspend' ? { reason } : {});
    reload();
  };
  return (
    <>
      <h2 className="sc-h3">All apps (admin)</h2>
      <label className="sc-card sc-form">
        <span>Suspension reason (optional)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="dev-admin-reason" />
      </label>
      {(data?.apps ?? []).map((a) => (
        <section key={a.id} className="sc-card sc-note" data-testid="dev-admin-app" data-status={a.status}>
          <b>{a.name}</b> <span className="sc-meta">· {a.owner?.email} · {a.users} connected · {a.status}</span>
          <div className="sc-actions">
            {a.status === 'active' ? (
              <button type="button" className="sc-link danger" onClick={() => void act(a, 'suspend')} data-testid="dev-admin-suspend">
                Suspend
              </button>
            ) : (
              <button type="button" className="sc-btn small ghost" onClick={() => void act(a, 'reactivate')} data-testid="dev-admin-reactivate">
                Reactivate
              </button>
            )}
          </div>
        </section>
      ))}
    </>
  );
}

/* ======================= Settings → Connected apps ======================= */

export function ConnectedAppsPage() {
  return (
    <section className="sc-page feed-page" data-testid="connected-apps-page">
      <TopBar title="Connected apps" />
      <ConnectedApps />
    </section>
  );
}

function ConnectedApps() {
  const { data, error, reload } = useLoad<{ apps: FeedConnectedApp[] }>('/api/feed/connected-apps');
  const [msg, setMsg] = useState('');
  const confirm = useConfirm();
  const revoke = async (a: FeedConnectedApp) => {
    if (!(await confirm({ title: `Disconnect ${a.name}?`, body: 'It stops working for your account right away. Posts it already made stay up; you can delete them yourself.', confirmLabel: 'Disconnect', danger: true }))) return;
    try {
      await api(`/api/feed/connected-apps/${a.appId}`, 'DELETE');
      setMsg(`${a.name} is disconnected.`);
      reload();
    } catch (err) {
      setMsg(errText(err, 'Couldn’t disconnect it'));
    }
  };
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="sc-meta">Loading…</p>;
  return (
    <>
      <p className="sc-meta">Apps you’ve allowed to use your Feed account. Disconnecting one stops it immediately.</p>
      {msg && (
        <p className="sc-toast" role="status" data-testid="connected-msg">
          {msg}
        </p>
      )}
      {data.apps.length === 0 ? (
        <p className="sc-card sc-note" data-testid="connected-none">
          No apps are connected.
        </p>
      ) : (
        data.apps.map((a) => (
          <section key={a.appId} className="sc-card sc-note" data-testid="connected-app">
            <h2 className="sc-h3">{a.name}</h2>
            {a.status === 'suspended' && <p className="sc-meta">The Feed has suspended this app; it can’t act for you.</p>}
            <ul className="sc-details">
              {a.scopes.map((s) => (
                <li key={s}>
                  <span>Can</span> <b>{FEED_API_SCOPE_LABELS[s].split(' (')[0]}</b>
                </li>
              ))}
              <li>
                <span>Since</span> <b>{new Date(a.connectedAt).toLocaleDateString()}</b>
              </li>
              {a.website && (
                <li>
                  <span>Website</span> <b>{a.website}</b>
                </li>
              )}
            </ul>
            <button type="button" className="sc-btn small ghost" onClick={() => void revoke(a)} data-testid="connected-revoke">
              Disconnect
            </button>
          </section>
        ))
      )}
    </>
  );
}

/* ======================= /oauth/authorize (the consent page) ======================= */

const RESUME_KEY = 'feed.oauthResume';

/** Signed out on the consent page → remember it, so signing in comes back here (30 minutes). */
function rememberAuthorize(): void {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({ url: window.location.pathname + window.location.search, at: Date.now() }));
  } catch {
    /* without storage they just open the app's link again */
  }
}

/** Mounted once signed in: if a consent page was waiting, go back to it. */
export function ResumeAuthorize() {
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      if (!raw) return;
      localStorage.removeItem(RESUME_KEY);
      const v = JSON.parse(raw) as { url?: unknown; at?: unknown };
      if (typeof v.url === 'string' && v.url.startsWith('/oauth/authorize?') && typeof v.at === 'number' && Date.now() - v.at < 30 * 60_000) window.location.replace(v.url);
    } catch {
      /* nothing to resume */
    }
  }, []);
  return null;
}

interface AuthorizeInfo {
  app: { name: string; description: string; website: string; developer: string | null };
  scopes: Array<{ scope: FeedApiScope; label: string }>;
  account: { displayName: string; username: string | null; email: string };
  alreadyConnected: boolean;
  redirectHost: string;
}

export function OAuthAuthorizePage() {
  useEffect(() => {
    document.body.classList.add('sc-body');
    return () => document.body.classList.remove('sc-body');
  }, []);
  return (
    <div className="app sc-app" data-testid="oauth-page">
      <main className="sc-main">
        <section className="sc-page" style={{ paddingTop: 24 }}>
          <div className="sc-row" style={{ justifyContent: 'center' }}>
            <FeedHorn tile size={44} />
          </div>
          <Authorize />
        </section>
      </main>
    </div>
  );
}

type AuthorizeState =
  | { kind: 'loading' }
  | { kind: 'out' }
  | { kind: 'error'; message: string; code?: string; back?: string }
  | { kind: 'ready'; info: AuthorizeInfo };

function Authorize() {
  const params = window.location.search;
  const [state, setState] = useState<AuthorizeState>({ kind: 'loading' });
  const [ticked, setTicked] = useState<FeedApiScope[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AuthorizeInfo>(`/api/oauth/authorize/info${params}`)
      .then((info) => setState({ kind: 'ready', info }))
      .catch((e: unknown) => {
        if (e instanceof ApiFail && e.status === 401) {
          rememberAuthorize();
          setState({ kind: 'out' });
        } else if (e instanceof ApiFail) {
          const back = typeof e.details?.redirect === 'string' ? e.details.redirect : undefined;
          setState({ kind: 'error', message: e.message, code: e.code, back });
        } else setState({ kind: 'error', message: 'Couldn’t reach The Feed. Try again in a moment.' });
      });
  }, [params]);

  const decide = async (approve: boolean) => {
    if (state.kind !== 'ready') return;
    setBusy(true);
    const p = Object.fromEntries(new URLSearchParams(params));
    try {
      const out = await api<{ redirect: string }>('/api/oauth/authorize/decision', 'POST', { ...p, approve, grant: approve ? ticked : [] });
      window.location.assign(out.redirect);
    } catch (e) {
      setBusy(false);
      setState({ kind: 'error', message: errText(e, 'Couldn’t finish connecting') });
    }
  };

  if (state.kind === 'loading') return <p className="sc-meta sc-center">Loading…</p>;
  if (state.kind === 'out')
    return (
      <section className="sc-card sc-note sc-center" data-testid="oauth-signed-out">
        <h1 className="sc-h2">Sign in to The Feed first</h1>
        <p>An app wants to connect to your Feed account. Sign in, and you’ll come right back here to decide.</p>
        <a className="sc-btn" href="/" data-testid="oauth-sign-in">
          Sign in
        </a>
      </section>
    );
  if (state.kind === 'error')
    return (
      <section className="sc-card sc-note" data-testid="oauth-error" data-code={state.code ?? ''}>
        <h1 className="sc-h2">{state.code === 'adults_only' ? 'The Feed is for grown-ups' : state.code === 'no_profile' ? 'Set up your Feed profile first' : 'This app can’t connect'}</h1>
        <p>{state.message}</p>
        {state.code === 'no_profile' && (
          <a className="sc-btn small" href="/feed">
            Set up my profile
          </a>
        )}
        {state.back && (
          <a className="sc-btn small ghost" href={state.back} data-testid="oauth-back">
            Return to the app
          </a>
        )}
      </section>
    );
  const { info } = state;
  return (
    <form
      className="sc-card sc-note"
      data-testid="oauth-consent"
      onSubmit={(e) => {
        e.preventDefault();
        void decide(true);
      }}
    >
      <h1 className="sc-h2" data-testid="oauth-app-name">
        {info.app.name} wants to connect to your Feed account
      </h1>
      {info.app.description && <p>{info.app.description}</p>}
      <p className="sc-meta">
        {info.app.developer ? `Made by ${info.app.developer}` : 'Made by a Feed developer'}
        {info.app.website ? ` · ${info.app.website}` : ''} · returns you to {info.redirectHost}
      </p>
      <p data-testid="oauth-account">
        Connecting as <b>{info.account.displayName}</b>
        {info.account.username ? ` (@${info.account.username})` : ''} · {info.account.email}{' '}
        <button type="button" className="sc-link small" onClick={() => void signOut()} data-testid="oauth-switch">
          Not you?
        </button>
      </p>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 10 }}>
        <legend className="sc-h3">Tick what you allow:</legend>
        {info.scopes.map((s) => (
          <label key={s.scope} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={ticked.includes(s.scope)}
              onChange={(e) => setTicked(e.target.checked ? [...ticked, s.scope] : ticked.filter((x) => x !== s.scope))}
              data-testid={`oauth-scope-${s.scope}`}
            />
            <span>{s.label}</span>
          </label>
        ))}
      </fieldset>
      <p className="sc-meta">
        It can never post to any kids’ space, never read your messages, and never act as anyone but you. Disconnect it any time in Settings → Connected apps.
        {info.alreadyConnected ? ' You’ve connected it before; this adds to what it already has.' : ''}
      </p>
      <div className="sc-row">
        <button type="submit" className="sc-btn" disabled={busy || ticked.length === 0} data-testid="oauth-allow">
          Allow
        </button>
        <button type="button" className="sc-btn ghost" disabled={busy} onClick={() => void decide(false)} data-testid="oauth-deny">
          Cancel
        </button>
      </div>
    </form>
  );
}
