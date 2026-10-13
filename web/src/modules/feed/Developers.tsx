/**
 * The Feed Publishing API, from the app side:
 *   /feed/developers  -- register and manage your apps (client_id, the once-shown secret); admins also see
 *                        every app and can suspend or reactivate it.
 */
import { useState, type FormEvent } from 'react';
import { FEED_API_SCOPES, FEED_API_SCOPE_LABELS, type CommunityMe, type FeedApiApp, type FeedApiAppCreated, type FeedApiScope } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
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
