import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { CirclePost, CircleSummary, CircleView, ModerationQueue, TeenActivity } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { useSession } from '../../session';
import { ago } from '../../dates';

const SAFETY = 'No direct messages, ever. Kids under 13 can’t join; teens appear as “Teen member” and a parent approves what they post.';

/** Circle list: join family-safe groups. */
export default function Circles() {
  const { isAdult } = useSession();
  const { data, error, setData } = useLoad<{ circles: CircleSummary[] }>('/api/circles');
  const [form, setForm] = useState({ name: '', description: '', teenOk: false });
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const reload = async (): Promise<void> => setData(await api<{ circles: CircleSummary[] }>('/api/circles'));
  return (
    <section>
      <h1>Circles</h1>
      <p className="muted small">{SAFETY}</p>
      {isAdult && (
        <p>
          <Link to="/circles/moderation">Moderation &amp; teen activity →</Link>
        </p>
      )}
      {msg && <p className="muted" role="status">{msg}</p>}
      <div data-testid="circle-list">
        {data.circles.map((c) => (
          <div key={c.id} className="card">
            <div className="row">
              <h2 className="grow" style={{ margin: 0 }}>
                {c.joined ? <Link to={`/circles/${c.id}`}>{c.name}</Link> : c.name}
              </h2>
              {c.teenOk && <span className="pill">teens welcome</span>}
            </div>
            <p className="small">{c.description}</p>
            <div className="row">
              <small className="muted grow">{c.members} members</small>
              {c.joined ? (
                <Link className="btn small" to={`/circles/${c.id}`}>
                  Open
                </Link>
              ) : (
                <button className="btn small" onClick={() => void api(`/api/circles/${c.id}/join`, 'POST').then(reload).then(() => setMsg(`Joined ${c.name}`))}>
                  Join
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {isAdult && (
        <details className="card">
          <summary>
            <b>Start a circle</b>
          </summary>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void api('/api/circles', 'POST', form)
                .then(reload)
                .then(() => {
                  setForm({ name: '', description: '', teenOk: false });
                  setMsg('Circle started — you moderate it');
                })
                .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not create'));
            }}
          >
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Circle name" required maxLength={60} />
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What it’s for" maxLength={300} />
            <label className="inline-label">
              <input type="checkbox" checked={form.teenOk} onChange={(e) => setForm({ ...form, teenOk: e.target.checked })} /> Teens (13+) may join
            </label>
            <button className="btn small">Start circle</button>
          </form>
        </details>
      )}
    </section>
  );
}

function Post({ p, onChange }: { p: CirclePost; onChange: (v: CircleView | null) => void }) {
  const confirm = useConfirm();
  const [comment, setComment] = useState('');
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="card" data-testid="circle-post">
      <div className="row">
        <b className="grow">{p.author}</b>
        {p.status === 'pending' && <span className="pill sun">waiting for a parent’s OK</span>}
        <small className="muted">{ago(p.at)}</small>
      </div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{p.body}</p>
      {p.status === 'visible' && (
        <div className="chips">
          {p.reactions.map((r) => (
            <button key={r.emoji} className={r.mine ? 'chip on' : 'chip'} aria-label={`React ${r.emoji}`} onClick={() => void api<CircleView>(`/api/circles/posts/${p.id}/react`, 'POST', { emoji: r.emoji }).then(onChange)}>
              {r.emoji} {r.count || ''}
            </button>
          ))}
        </div>
      )}
      {p.comments.map((c) => (
        <p key={c.id} className="small" style={{ borderLeft: '3px solid var(--line)', paddingLeft: 8 }}>
          <b>{c.author}</b> {c.status === 'pending' && <span className="pill">waiting for OK</span>} {c.body}
        </p>
      ))}
      {p.status === 'visible' && (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void api<CircleView>(`/api/circles/posts/${p.id}/comments`, 'POST', { body: comment }).then((v) => {
              setComment('');
              onChange(v);
            });
          }}
        >
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Reply kindly…" maxLength={1000} aria-label="Comment" />
          <button className="btn small">Reply</button>
        </form>
      )}
      <div className="row">
        {p.mine ? (
          <button
            className="link danger"
            onClick={() =>
              void confirm({ title: 'Take this post down?', confirmLabel: 'Take down', danger: true }).then(
                (y) => void (y && api(`/api/circles/posts/${p.id}`, 'DELETE').then(() => onChange(null))),
              )
            }
          >
            Take down
          </button>
        ) : (
          <button
            className="link"
            onClick={() =>
              void confirm({ title: 'Report this post?', body: 'A moderator will review it. Three reports hide it until then.', confirmLabel: 'Report' }).then(
                (y) => void (y && api('/api/circles/report', 'POST', { type: 'post', id: p.id, reason: 'reported from the app' }).then(() => setNote('Reported — thank you.'))),
              )
            }
          >
            Report
          </button>
        )}
        {note && <small className="muted">{note}</small>}
      </div>
    </div>
  );
}

/** One circle: posts, replies, reactions. */
export function Circle() {
  const { id } = useParams();
  const confirm = useConfirm();
  const { data, error, setData, reload } = useLoad<CircleView>(id ? `/api/circles/${encodeURIComponent(id)}` : null);
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <section>
      <p>
        <Link to="/circles">← Circles</Link>
      </p>
      <h1>{data.circle.name}</h1>
      <p className="muted small">{SAFETY}</p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void api<CircleView>(`/api/circles/${data.circle.id}/posts`, 'POST', { body })
            .then((v) => {
              setData(v);
              setBody('');
              setMsg(v.posts[0]?.status === 'pending' ? 'Sent to your parent to OK first.' : 'Posted');
            })
            .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not post'));
        }}
      >
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Share a win, a question, what helped…" maxLength={2000} required aria-label="New post" />
        <button className="btn small">Post</button>
      </form>
      {msg && <p className="muted small" role="status">{msg}</p>}
      <div data-testid="circle-posts">
        {data.posts.map((p) => (
          <Post key={p.id} p={p} onChange={(v) => (v ? setData(v) : reload())} />
        ))}
        {data.posts.length === 0 && <p className="muted">No posts yet — say hi.</p>}
      </div>
      <button
        className="link"
        onClick={() =>
          void confirm({ title: `Leave ${data.circle.name}?`, confirmLabel: 'Leave' }).then(
            (y) => void (y && api(`/api/circles/${data.circle.id}/leave`, 'POST').then(() => (window.location.href = '/circles'))),
          )
        }
      >
        Leave this circle
      </button>
    </section>
  );
}

/** Parents: approve teen posts, review reports (moderators/admins), and see all teen activity. */
export function Moderation() {
  const q = useLoad<ModerationQueue>('/api/circles/moderation/queue');
  const t = useLoad<TeenActivity>('/api/circles/activity/teens');
  const [msg, setMsg] = useState<string | null>(null);
  if (q.error) return <p className="error">{q.error}</p>;
  if (!q.data) return <p className="muted">Loading…</p>;
  const act = (type: string, id: number, action: string): void =>
    void api<ModerationQueue>(`/api/circles/moderation/${type}/${id}/${action}`, 'POST')
      .then((d) => {
        q.setData(d);
        t.reload();
        setMsg(action === 'approve' ? 'Approved' : action === 'remove' ? 'Removed' : 'Dismissed');
      })
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Could not save'));
  return (
    <section>
      <p>
        <Link to="/circles">← Circles</Link>
      </p>
      <h1>Moderation</h1>
      {msg && <p className="muted" role="status">{msg}</p>}
      <div className="card" data-testid="moderation-queue">
        <h2>Waiting on you</h2>
        {q.data.items.length === 0 && <p className="muted">Nothing to review.</p>}
        {q.data.items.map((i) => (
          <div key={`${i.type}${i.id}`} className="quest">
            <span className="grow">
              <span className="pill">{i.reason === 'teen_approval' ? 'your teen' : `${i.reports.length} report${i.reports.length === 1 ? '' : 's'}`}</span> <b>{i.author}</b> in {i.circle}
              <br />
              <small>{i.body}</small>
            </span>
            <button className="btn small" onClick={() => act(i.type, i.id, 'approve')}>
              Approve
            </button>
            <button className="btn small danger" onClick={() => act(i.type, i.id, 'remove')}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="card" data-testid="teen-activity">
        <h2>Your teens in circles</h2>
        {(t.data?.items.length ?? 0) === 0 && <p className="muted">No teen activity yet.</p>}
        <ul className="plain small">
          {t.data?.items.map((i, n) => (
            <li key={n}>
              {i.at.slice(0, 10)} · <b>{i.teen}</b> {i.type} in {i.circle}: {i.body} <span className="muted">({i.status})</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
