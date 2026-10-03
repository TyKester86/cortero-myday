import { useEffect, useState, type FormEvent } from 'react';
import type { Errand, ErrandsState } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { when } from '../../dates';

const LIVE: Errand['status'][] = ['queued', 'running', 'needs_ok', 'needs_input'];
const STATUS: Record<Errand['status'], string> = {
  queued: 'Starting…',
  running: 'Working…',
  needs_ok: 'Needs your OK',
  needs_input: 'Has a question',
  done: 'Done',
  failed: 'Stopped',
  cancelled: 'Cancelled',
};

/**
 * Hana step 5: saved website logins + errands Hana runs in a real browser.
 * Passwords are encrypted and never shown again; anything that spends money
 * waits for an OK here.
 */
export default function Errands() {
  const { data, error, setData, reload } = useLoad<ErrandsState>('/api/errands');
  const live = data?.errands.some((e) => LIVE.includes(e.status)) ?? false;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [live, reload]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <section data-testid="errands">
      <h1>Hana’s errands</h1>
      <p className="muted small">Hana signs in to websites for you and does the clicking — reorders, checking an order, booking a table. She always asks before anything is bought.</p>
      {!data.available && <p className="card note small">Errands aren’t switched on for this server yet. You can still save logins now.</p>}
      {data.available && <NewErrand state={data} onChange={setData} />}
      {data.errands.map((e) => (
        <ErrandCard key={e.id} e={e} onChange={setData} />
      ))}
      <Logins state={data} onChange={setData} />
    </section>
  );
}

function NewErrand({ state, onChange }: { state: ErrandsState; onChange: (s: ErrandsState) => void }) {
  const [goal, setGoal] = useState('');
  const [site, setSite] = useState(state.logins[0] ? String(state.logins[0].id) : 'url');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    try {
      onChange(await api<ErrandsState>('/api/errands', 'POST', site === 'url' ? { goal, url } : { goal, loginId: Number(site) }));
      setGoal('');
      setErr(null);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'That didn’t start');
    }
  };
  return (
    <form className="card" onSubmit={(e) => void submit(e)} data-testid="new-errand">
      <h2>New errand</h2>
      <label>
        What should Hana do?
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} maxLength={500} placeholder="Reorder our usual groceries for pickup Saturday, under $120" required />
      </label>
      <label>
        Where
        <select value={site} onChange={(e) => setSite(e.target.value)}>
          {state.logins.map((l) => (
            <option key={l.id} value={l.id}>
              {l.site} (signed in as {l.usernameHint})
            </option>
          ))}
          <option value="url">Another website…</option>
        </select>
      </label>
      {site === 'url' && (
        <label>
          Website
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="opentable.com" required />
        </label>
      )}
      {err && <p className="error">{err}</p>}
      <button className="btn">Start</button>
    </form>
  );
}

function ErrandCard({ e, onChange }: { e: Errand; onChange: (s: ErrandsState) => void }) {
  const [answer, setAnswer] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const confirm = useConfirm();
  const go = async (p: Promise<ErrandsState>): Promise<void> => {
    try {
      onChange(await p);
      setErr(null);
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t go through');
    }
  };
  const live = LIVE.includes(e.status);
  return (
    <div className="card errand" data-testid="errand" data-status={e.status}>
      <div className="ex-head">
        <b>{e.goal}</b>
        <span className={`pill${e.status === 'needs_ok' || e.status === 'needs_input' ? ' sun' : ''}`}>{STATUS[e.status]}</span>
      </div>
      <p className="muted small">
        {e.site} · {when(e.createdAt)}
      </p>
      {e.status === 'needs_ok' && (
        <div className="approve" role="alertdialog" aria-label={`Approve: ${e.ask}`} data-testid="errand-approve">
          <p>
            <b>Hana wants to:</b> {e.ask}
          </p>
          <p className="muted small">Nothing is bought until you approve. One OK covers just this one step.</p>
          <div className="confirm-actions">
            <button className="btn small ghost" onClick={() => void go(api<ErrandsState>(`/api/errands/${e.id}/cancel`, 'POST'))}>
              Stop
            </button>
            <button className="btn small" onClick={() => void go(api<ErrandsState>(`/api/errands/${e.id}/approve`, 'POST'))}>
              Approve
            </button>
          </div>
        </div>
      )}
      {e.status === 'needs_input' && (
        <form
          className="inline"
          data-testid="errand-answer"
          onSubmit={(ev) => {
            ev.preventDefault();
            void go(api<ErrandsState>(`/api/errands/${e.id}/answer`, 'POST', { text: answer })).then(() => setAnswer(''));
          }}
        >
          <label>
            {e.ask}
            <input value={answer} onChange={(ev) => setAnswer(ev.target.value)} autoComplete="one-time-code" required />
          </label>
          <button className="btn small">Send</button>
        </form>
      )}
      {e.result && <p data-testid="errand-result">{e.result}</p>}
      {e.hasShot && (
        <details>
          <summary className="small">What Hana sees</summary>
          <img className="errand-shot" src={`/api/errands/${e.id}/shot?v=${e.steps.length}`} alt="The browser page Hana is on" loading="lazy" />
        </details>
      )}
      {e.steps.length > 0 && (
        <details open={live}>
          <summary className="small">Steps ({e.steps.length})</summary>
          <ol className="small steps" data-testid="errand-steps">
            {e.steps.map((s, i) => (
              <li key={i}>{s.say}</li>
            ))}
          </ol>
        </details>
      )}
      {err && <p className="error">{err}</p>}
      <div className="row">
        {live && e.status !== 'needs_ok' && (
          <button className="link danger small" onClick={() => void go(api<ErrandsState>(`/api/errands/${e.id}/cancel`, 'POST'))}>
            Stop this errand
          </button>
        )}
        {!live && (
          <button
            className="link small"
            onClick={() =>
              void confirm({ title: 'Remove this errand?', body: 'Its steps and screenshot are deleted.', confirmLabel: 'Remove', danger: true }).then(
                (y) => void (y && go(api<ErrandsState>(`/api/errands/${e.id}`, 'DELETE'))),
              )
            }
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function Logins({ state, onChange }: { state: ErrandsState; onChange: (s: ErrandsState) => void }) {
  const [site, setSite] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const confirm = useConfirm();
  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    try {
      onChange(await api<ErrandsState>('/api/errands/logins', 'POST', { site, url, username, password }));
      setSite('');
      setUrl('');
      setUsername('');
      setPassword('');
      setErr(null);
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Could not save');
    }
  };
  return (
    <div className="card" data-testid="saved-logins">
      <h2>Saved logins</h2>
      <p className="muted small">Only you can use these — not even another grown-up in your household. Passwords are encrypted, never shown again, never seen by the AI, and only typed on the website they belong to.</p>
      {state.logins.length === 0 && <p className="muted">None yet.</p>}
      <ul className="plain rows">
        {state.logins.map((l) => (
          <li key={l.id} data-testid="saved-login">
            <span>
              <b>{l.site}</b> <span className="muted small">{l.usernameHint} · ••••••••</span>
            </span>
            <button
              className="link danger"
              onClick={() =>
                void confirm({ title: `Forget your ${l.site} login?`, body: 'Hana won’t be able to sign in there until you add it again.', confirmLabel: 'Forget it', danger: true }).then(
                  (y) => void (y && api<ErrandsState>(`/api/errands/logins/${l.id}`, 'DELETE').then(onChange)),
                )
              }
            >
              Forget
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void save(e)} data-testid="add-login" autoComplete="off">
        <div className="inline">
          <label>
            Name
            <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="Walmart" maxLength={60} />
          </label>
          <label>
            Website
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="walmart.com" required />
          </label>
        </div>
        <div className="inline">
          <label>
            Username or email
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          </label>
        </div>
        {err && <p className="error">{err}</p>}
        <button className="btn small">Save login</button>
      </form>
    </div>
  );
}
