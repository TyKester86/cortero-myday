/**
 * The Village (parents forum) and The Feed (social), grown-ups 18+ only.
 * Kids and teens have no nav entry and the API answers them 403.
 */
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  COMMUNITY_SAFETY_LINE,
  CRISIS_RESOURCES,
  VILLAGE_CATEGORIES,
  type CommunityAuthor,
  type CommunityMe,
  type CommunityProfile,
  type CommunityQueue,
  type FeedPage,
  type FeedPost,
  type ReviewNote,
  type VillageCategory,
  type VillagePost,
  type VillageThread,
  type VillageThreadSummary,
} from '@myday/shared';
import { api, ApiFail, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { ago } from '../../dates';
import { shrink } from '../health/ProgressPhotos';

/* ---------- shared pieces ---------- */

export function CrisisCard() {
  return (
    <div className="card crisis" role="alert" data-testid="crisis-resources">
      <b>If you or someone else may be in danger, reach out now:</b>
      <ul>
        {CRISIS_RESOURCES.map((r) => (
          <li key={r.href}>
            <a href={r.href}>{r.label}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewBanner({ note }: { note: ReviewNote | null }) {
  if (!note?.underReview) return null;
  return (
    <>
      {note.crisis && <CrisisCard />}
      <p className="card note" role="status" data-testid="under-review">
        <b>Under review.</b> A moderator will look before others can see it{note.reasons.length ? ` (${note.reasons.join('; ')})` : ''}. You can still see it below.
      </p>
    </>
  );
}

function Who({ a }: { a: CommunityAuthor }) {
  return (
    <Link to={`/people/${a.userId}`} className="who-chip">
      {a.avatarUrl ? <img src={a.avatarUrl} alt="" className="avatar" width={28} height={28} /> : <span className="avatar blank" aria-hidden="true">{a.displayName.slice(0, 1)}</span>}
      <b>{a.displayName}</b>
      {a.parentBadge && <span className="pill">parent</span>}
    </Link>
  );
}

const REPORT_REASONS = ['Medical or dosage advice', 'Personal info about a kid or family', 'Unkind or attacking', 'Spam or selling', 'Someone may be in danger', 'Something else'];

function ReportButton({ path, onDone }: { path: string; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(REPORT_REASONS[0] ?? '');
  if (!open)
    return (
      <button className="link small" onClick={() => setOpen(true)}>
        Report
      </button>
    );
  return (
    <span className="inline" data-testid="report-form">
      <select aria-label="Why are you reporting this?" value={reason} onChange={(e) => setReason(e.target.value)}>
        {REPORT_REASONS.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
      <button
        className="btn small"
        onClick={() =>
          void api<{ hidden?: boolean }>(path, 'POST', { reason })
            .then((r) => onDone(r.hidden ? 'Reported — it’s hidden until a moderator looks.' : 'Reported — thank you. A moderator will look.'))
            .catch((e: unknown) => onDone(e instanceof Error ? e.message : 'Could not report'))
            .finally(() => setOpen(false))
        }
      >
        Send report
      </button>
      <button className="link small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}

/** Upload a photo (re-encoded on the phone, so location data is dropped). */
async function uploadPhoto(file: File): Promise<{ id: number; url: string; review: ReviewNote }> {
  const body = await shrink(file);
  const res = await fetch('/api/community/images', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'image/jpeg', 'X-MyDay-Upload': '1' },
    body,
  });
  const out = (await res.json().catch(() => null)) as { id: number; url: string; review: ReviewNote; error?: string } | null;
  if (!res.ok || !out) throw new ApiFail(res.status, out?.error ?? 'Upload failed');
  return out;
}

/* ---------- the gate: profile, guidelines, 18+ ---------- */

function Setup({ me, onDone }: { me: CommunityMe; onDone: () => void }) {
  const [f, setF] = useState({ displayName: '', bio: '', parentBadge: true, adult: false, guidelines: false });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="card form"
      data-testid="community-setup"
      onSubmit={(e) => {
        e.preventDefault();
        void api('/api/community/profile', 'PUT', f)
          .then(onDone)
          .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not save'));
      }}
    >
      <h2>Join the MyDay community</h2>
      <p className="small">The Village and the Feed are for grown-ups raising kids with ADHD. Please read these first:</p>
      <ol className="small guidelines" data-testid="guidelines">
        {me.guidelines.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ol>
      <label>
        First name only
        <input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required maxLength={24} autoComplete="given-name" />
      </label>
      <label>
        A short bio (optional — no kids’ names or schools)
        <input value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={280} />
      </label>
      <label className="inline-label">
        <input type="checkbox" checked={f.parentBadge} onChange={(e) => setF({ ...f, parentBadge: e.target.checked })} /> Show a “parent” badge
      </label>
      <label className="inline-label">
        <input type="checkbox" checked={f.adult} onChange={(e) => setF({ ...f, adult: e.target.checked })} /> I’m 18 or older
      </label>
      <label className="inline-label">
        <input type="checkbox" checked={f.guidelines} onChange={(e) => setF({ ...f, guidelines: e.target.checked })} /> I’ve read and accept the community guidelines
      </label>
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
      <button className="btn" disabled={!f.adult || !f.guidelines}>
        Join
      </button>
    </form>
  );
}

function Gate({ children }: { children: (me: CommunityMe) => ReactNode }) {
  const { data, error, reload } = useLoad<CommunityMe>('/api/community/me');
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  if (data.banned) return <p className="card">Your community access has been removed for breaking the guidelines.</p>;
  return (
    <>
      <p className="small muted safety-line" data-testid="safety-line">
        {COMMUNITY_SAFETY_LINE}
      </p>
      {data.mutedUntil && <p className="card note">You’re muted until {new Date(data.mutedUntil).toLocaleDateString()} — you can read, but not post.</p>}
      {data.profile ? children(data) : <Setup me={data} onDone={reload} />}
    </>
  );
}

/* ---------- The Village ---------- */

export function Village() {
  return (
    <section data-testid="village">
      <h1>The Village</h1>
      <p className="muted small">Moms and dads with ADHD, raising kids with ADHD. First names only.</p>
      <Gate>{(me) => <VillageList me={me} />}</Gate>
    </section>
  );
}

function VillageList({ me }: { me: CommunityMe }) {
  const [cat, setCat] = useState<VillageCategory | ''>('');
  const { data, reload } = useLoad<{ threads: VillageThreadSummary[] }>(`/api/village${cat ? `?category=${cat}` : ''}`);
  const [f, setF] = useState({ category: 'wins' as VillageCategory, title: '', body: '' });
  const [review, setReview] = useState<ReviewNote | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      {me.isModerator && (
        <p>
          <Link to="/community/moderation">Moderation queue →</Link>
        </p>
      )}
      <div className="chips" role="group" aria-label="Category">
        <button className={cat === '' ? 'chip on' : 'chip'} onClick={() => setCat('')}>
          All
        </button>
        {VILLAGE_CATEGORIES.map((c) => (
          <button key={c.key} className={cat === c.key ? 'chip on' : 'chip'} onClick={() => setCat(c.key)}>
            {c.label}
          </button>
        ))}
      </div>
      <ReviewBanner note={review} />
      {msg && <p className="muted" role="status">{msg}</p>}
      <div data-testid="thread-list">
        {data?.threads.map((t) => (
          <Link key={t.id} to={`/village/${t.id}`} className="card thread-row">
            <div className="row">
              <b className="grow">{t.title}</b>
              {t.status !== 'visible' && <span className="pill sun">under review</span>}
            </div>
            <small className="muted">
              {VILLAGE_CATEGORIES.find((c) => c.key === t.category)?.label} · {t.author.displayName} · {t.replies} {t.replies === 1 ? 'reply' : 'replies'} · {ago(t.lastActivity)}
            </small>
          </Link>
        ))}
        {data && !data.threads.length && <p className="muted">Nothing here yet — start the first conversation.</p>}
      </div>
      {!me.mutedUntil && (
        <details className="card">
          <summary>
            <b>Start a conversation</b>
          </summary>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              setMsg(null);
              void api<{ review: ReviewNote }>('/api/village/threads', 'POST', f)
                .then((r) => {
                  setReview(r.review);
                  setF({ ...f, title: '', body: '' });
                  reload();
                })
                .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not post'));
            }}
          >
            <select aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as VillageCategory })}>
              {VILLAGE_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <input aria-label="Title" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={120} />
            <textarea aria-label="What’s going on?" placeholder="What’s going on?" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required maxLength={5000} rows={5} />
            <button className="btn small">Post</button>
          </form>
        </details>
      )}
    </>
  );
}

export function VillageThreadPage() {
  const { id } = useParams();
  return (
    <section data-testid="village-thread">
      <p>
        <Link to="/village">← The Village</Link>
      </p>
      <Gate>{(me) => <Thread id={id ?? ''} me={me} />}</Gate>
    </section>
  );
}

function Thread({ id, me }: { id: string; me: CommunityMe }) {
  const { data, error, setData } = useLoad<VillageThread>(`/api/village/threads/${encodeURIComponent(id)}`);
  const [reply, setReply] = useState('');
  const [review, setReview] = useState<ReviewNote | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <h1>{data.title}</h1>
      <small className="muted">{VILLAGE_CATEGORIES.find((c) => c.key === data.category)?.label}</small>
      <ReviewBanner note={review} />
      {msg && <p className="muted" role="status">{msg}</p>}
      {data.posts.map((p) => (
        <VPost key={p.id} p={p} onThread={setData} onMsg={setMsg} />
      ))}
      {data.status === 'visible' && !me.mutedUntil && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void api<{ thread: VillageThread; review: ReviewNote }>(`/api/village/threads/${data.id}/replies`, 'POST', { body: reply })
              .then((r) => {
                setData(r.thread);
                setReview(r.review);
                setReply('');
              })
              .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not reply'));
          }}
        >
          <textarea aria-label="Reply" placeholder="Reply kindly…" value={reply} onChange={(e) => setReply(e.target.value)} required maxLength={5000} rows={3} />
          <button className="btn small">Reply</button>
        </form>
      )}
    </>
  );
}

function VPost({ p, onThread, onMsg }: { p: VillagePost; onThread: (t: VillageThread) => void; onMsg: (m: string) => void }) {
  const confirm = useConfirm();
  const react = (kind: 'heart' | 'been-there'): void => void api<VillageThread>(`/api/village/posts/${p.id}/react`, 'POST', { kind }).then(onThread);
  return (
    <div className={p.opening ? 'card opening' : 'card'} data-testid="village-post">
      <div className="row">
        <span className="grow">
          <Who a={p.author} />
        </span>
        {p.status !== 'visible' && <span className="pill sun">under review</span>}
        <small className="muted">{ago(p.at)}</small>
      </div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{p.body}</p>
      {p.status === 'visible' && (
        <div className="chips">
          <button className={p.reactions.mine.includes('heart') ? 'chip on' : 'chip'} aria-label="Heart" onClick={() => react('heart')}>
            ♥ {p.reactions.heart || ''}
          </button>
          <button className={p.reactions.mine.includes('been-there') ? 'chip on' : 'chip'} onClick={() => react('been-there')}>
            Been there {p.reactions.beenThere || ''}
          </button>
          {!p.opening && !p.mine && (
            <button className={p.markedHelpfulByMe ? 'chip on' : 'chip'} onClick={() => void api<VillageThread>(`/api/village/posts/${p.id}/helpful`, 'POST').then(onThread)}>
              Helpful {p.helpful || ''}
            </button>
          )}
          {!p.opening && p.mine && p.helpful > 0 && <span className="pill good">marked helpful ×{p.helpful}</span>}
        </div>
      )}
      <div className="row">
        {p.mine ? (
          <button
            className="link danger small"
            onClick={() =>
              void confirm({ title: 'Delete this post?', confirmLabel: 'Delete', danger: true }).then(
                (y) => void (y && api(`/api/village/posts/${p.id}`, 'DELETE').then(() => onMsg('Deleted.'))),
              )
            }
          >
            Delete
          </button>
        ) : (
          <ReportButton path={`/api/village/posts/${p.id}/report`} onDone={onMsg} />
        )}
      </div>
    </div>
  );
}

/* ---------- The Feed ---------- */

export function Feed() {
  return (
    <section data-testid="feed">
      <h1>The Feed</h1>
      <Gate>{(me) => <FeedBody me={me} />}</Gate>
    </section>
  );
}

function FeedBody({ me }: { me: CommunityMe }) {
  const [tab, setTab] = useState<'following' | 'everyone'>('everyone');
  const { data, setData, reload } = useLoad<FeedPage>(`/api/feed?tab=${tab}`);
  const [more, setMore] = useState<FeedPost[]>([]);
  const [next, setNext] = useState<number | null | undefined>(undefined);
  const [review, setReview] = useState<ReviewNote | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const posts = [...(data?.posts ?? []), ...more];
  const cursor = next === undefined ? data?.next ?? null : next;
  const replace = (p: FeedPost): void => {
    if (data) setData({ ...data, posts: data.posts.map((x) => (x.id === p.id ? p : x)) });
    setMore(more.map((x) => (x.id === p.id ? p : x)));
  };
  return (
    <>
      <p>
        <Link to={`/people/${me.profile?.userId ?? ''}`}>Your profile →</Link>
        {me.isModerator && (
          <>
            {' · '}
            <Link to="/community/moderation">Moderation queue →</Link>
          </>
        )}
      </p>
      {!me.mutedUntil && (
        <Composer
          onPosted={(r) => {
            setReview(r);
            setMore([]);
            setNext(undefined);
            reload();
          }}
        />
      )}
      <ReviewBanner note={review} />
      {msg && <p className="muted" role="status">{msg}</p>}
      <nav className="subtabs" aria-label="Feed">
        {(['following', 'everyone'] as const).map((t) => (
          <button
            key={t}
            className={tab === t ? 'chip on' : 'chip'}
            aria-pressed={tab === t}
            onClick={() => {
              setTab(t);
              setMore([]);
              setNext(undefined);
            }}
          >
            {t === 'following' ? 'Following' : 'Everyone'}
          </button>
        ))}
      </nav>
      <div data-testid="feed-posts">
        {posts.map((p) => (
          <FeedCard key={p.id} p={p} onChange={replace} onMsg={setMsg} onGone={(id) => {
              setMore(more.filter((x) => x.id !== id));
              reload();
            }} />
        ))}
        {data && !posts.length && <p className="muted">{tab === 'following' ? 'Follow people to see their posts here.' : 'Nothing yet — say hi.'}</p>}
      </div>
      {cursor && (
        <button
          className="btn small ghost"
          onClick={() =>
            void api<FeedPage>(`/api/feed?tab=${tab}&before=${cursor}`).then((pg) => {
              setMore([...more, ...pg.posts]);
              setNext(pg.next);
            })
          }
        >
          Show more
        </button>
      )}
    </>
  );
}

function Composer({ onPosted }: { onPosted: (r: ReviewNote) => void }) {
  const [body, setBody] = useState('');
  const [photo, setPhoto] = useState<{ id: number; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="card form"
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        void api<{ review: ReviewNote }>('/api/feed/posts', 'POST', { body, imageId: photo?.id ?? null })
          .then((r) => {
            setBody('');
            setPhoto(null);
            onPosted(r.review);
          })
          .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not post'));
      }}
    >
      <textarea aria-label="Share something" placeholder="A win, a strategy, a laugh…" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={3} />
      {photo && <img src={photo.url} alt="Your photo" className="feed-photo" />}
      <div className="row">
        <label className="link small">
          {busy ? 'Adding…' : photo ? 'Change photo' : 'Add a photo'}
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setBusy(true);
              void uploadPhoto(file)
                .then((p) => setPhoto({ id: p.id, url: p.url }))
                .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not add the photo'))
                .finally(() => setBusy(false));
            }}
          />
        </label>
        <span className="grow" />
        <button className="btn small" disabled={busy || (!body.trim() && !photo)}>
          Post
        </button>
      </div>
      <small className="muted">No kids’ faces, names or schools. Photos and posts are checked before they appear.</small>
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
    </form>
  );
}

function FeedCard({ p, onChange, onMsg, onGone }: { p: FeedPost; onChange: (p: FeedPost) => void; onMsg: (m: string) => void; onGone: (id: number) => void }) {
  const confirm = useConfirm();
  return (
    <div className="card" data-testid="feed-post">
      <div className="row">
        <span className="grow">
          <Who a={p.author} />
        </span>
        {p.status !== 'visible' && <span className="pill sun">under review</span>}
        <small className="muted">{ago(p.at)}</small>
      </div>
      {p.body && <p style={{ whiteSpace: 'pre-wrap' }}>{p.body}</p>}
      {p.imageUrl && <img src={p.imageUrl} alt="" className="feed-photo" loading="lazy" />}
      <div className="row">
        {p.status === 'visible' && (
          <button className={p.likedByMe ? 'chip on' : 'chip'} aria-label={p.likedByMe ? 'Unlike' : 'Like'} onClick={() => void api<FeedPost>(`/api/feed/posts/${p.id}/like`, 'POST').then(onChange)}>
            ♥ {p.likes || ''}
          </button>
        )}
        <span className="grow" />
        {p.mine ? (
          <button
            className="link danger small"
            onClick={() =>
              void confirm({ title: 'Delete this post?', confirmLabel: 'Delete', danger: true }).then(
                (y) => void (y && api(`/api/feed/posts/${p.id}`, 'DELETE').then(() => onGone(p.id))),
              )
            }
          >
            Delete
          </button>
        ) : (
          <ReportButton path={`/api/feed/posts/${p.id}/report`} onDone={onMsg} />
        )}
      </div>
    </div>
  );
}

/* ---------- people ---------- */

export function PersonPage() {
  const { id } = useParams();
  return (
    <section data-testid="person">
      <p>
        <Link to="/feed">← The Feed</Link>
      </p>
      <Gate>{() => <Person id={id ?? ''} />}</Gate>
    </section>
  );
}

function Person({ id }: { id: string }) {
  const { data, error, setData } = useLoad<CommunityProfile>(`/api/community/people/${encodeURIComponent(id)}`);
  const posts = useLoad<FeedPage>(`/api/feed?author=${encodeURIComponent(id)}`);
  const [list, setList] = useState<'followers' | 'following' | null>(null);
  const people = useLoad<{ people: CommunityAuthor[] }>(list ? `/api/community/people/${encodeURIComponent(id)}/${list}` : null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="row">
        {data.avatarUrl ? <img src={data.avatarUrl} alt="" className="avatar big" width={64} height={64} /> : <span className="avatar big blank">{data.displayName.slice(0, 1)}</span>}
        <div className="grow">
          <h1 style={{ margin: 0 }}>{data.displayName}</h1>
          {data.parentBadge && <span className="pill">parent</span>}
        </div>
      </div>
      {data.bio && <p>{data.bio}</p>}
      <p className="chips" data-testid="follow-counts">
        <button className="chip" onClick={() => setList(list === 'followers' ? null : 'followers')}>
          {data.followers} followers
        </button>
        <button className="chip" onClick={() => setList(list === 'following' ? null : 'following')}>
          {data.following} following
        </button>
        <span className="chip">{data.posts} posts</span>
      </p>
      {list && (
        <div className="card" data-testid="people-list">
          {people.data?.people.map((a) => (
            <p key={a.userId}>
              <Who a={a} />
            </p>
          ))}
          {people.data && !people.data.people.length && <p className="muted">Nobody yet.</p>}
        </div>
      )}
      {msg && <p className="muted" role="status">{msg}</p>}
      {data.me ? (
        <>
          <button className="btn small ghost" onClick={() => setEditing(!editing)}>
            Edit profile
          </button>
          {editing && <EditProfile p={data} onSaved={(p) => {
                setData(p);
                setEditing(false);
              }} />}
        </>
      ) : (
        <div className="row">
          {data.followedByMe ? (
            <button className="btn small ghost" onClick={() => void api<CommunityProfile>(`/api/community/people/${data.userId}/follow`, 'DELETE').then(setData)}>
              Following ✓
            </button>
          ) : (
            <button className="btn small" onClick={() => void api<CommunityProfile>(`/api/community/people/${data.userId}/follow`, 'POST').then(setData)}>
              Follow
            </button>
          )}
          <ReportButton path={`/api/community/people/${data.userId}/report`} onDone={setMsg} />
          <button
            className="link danger small"
            onClick={() =>
              void confirm({ title: `Block ${data.displayName}?`, body: 'You won’t see each other’s posts, and neither of you can follow the other.', confirmLabel: 'Block', danger: true }).then(
                (y) =>
                  void (
                    y &&
                    api(`/api/community/people/${data.userId}/block`, 'POST').then(() => setMsg(`Blocked ${data.displayName}. You won’t see each other’s posts.`))
                  ),
              )
            }
          >
            Block
          </button>
        </div>
      )}
      <h2>Posts</h2>
      {posts.data?.posts.map((p) => (
        <FeedCard key={p.id} p={p} onChange={() => posts.reload()} onMsg={setMsg} onGone={() => posts.reload()} />
      ))}
    </>
  );
}

function EditProfile({ p, onSaved }: { p: CommunityProfile; onSaved: (p: CommunityProfile) => void }) {
  const [f, setF] = useState({ displayName: p.displayName, bio: p.bio, parentBadge: p.parentBadge });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (extra: Record<string, unknown> = {}): void =>
    void api<CommunityProfile>('/api/community/profile', 'PUT', { ...f, ...extra })
      .then(onSaved)
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Could not save'));
  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label>
        First name only
        <input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required maxLength={24} />
      </label>
      <label>
        Bio
        <input value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={280} />
      </label>
      <label className="inline-label">
        <input type="checkbox" checked={f.parentBadge} onChange={(e) => setF({ ...f, parentBadge: e.target.checked })} /> Show a “parent” badge
      </label>
      <label className="link small">
        {busy ? 'Adding…' : 'Profile photo (you, not your kids)'}
        <input
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy(true);
            void uploadPhoto(file)
              .then((ph) => {
                if (ph.review.underReview) setMsg('Your photo is under review — it shows once a moderator approves it.');
                save({ avatarId: ph.id });
              })
              .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not add the photo'))
              .finally(() => setBusy(false));
          }}
        />
      </label>
      {msg && <p className="muted">{msg}</p>}
      <button className="btn small">Save</button>
    </form>
  );
}

/* ---------- moderation (MyDay admins) ---------- */

export function CommunityModeration() {
  const { data, error, setData } = useLoad<CommunityQueue>('/api/community/moderation/queue');
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const act = (kind: string, id: number, action: string): void =>
    void api<CommunityQueue & { struck: string | null }>(`/api/community/moderation/${kind}/${id}/${action}`, 'POST', {}).then((q) => {
      setData(q);
      setMsg(q.struck ? `Done — strike recorded: ${q.struck}.` : 'Done.');
    });
  return (
    <section data-testid="community-moderation">
      <h1>Community moderation</h1>
      <p className="muted small">Crisis items first. Approve, remove, or remove + strike (warn → 7-day mute → ban).</p>
      {msg && <p role="status">{msg}</p>}
      {!data.items.length && <p className="muted">The queue is empty.</p>}
      {data.items.map((i) => (
        <div key={`${i.kind}-${i.id}`} className={i.priority >= 2 ? 'card crisis' : 'card'} data-testid="queue-item">
          <div className="row">
            <b className="grow">
              {i.priority >= 2 && '⚠ '}
              {i.kind === 'village' ? 'Village' : i.kind === 'feed' ? 'Feed' : i.kind === 'image' ? 'Photo' : 'Profile'} · {i.author.displayName} ({i.author.email}) · {i.author.strikes} strikes
            </b>
            <span className="pill">{i.status}</span>
          </div>
          {i.title && <b>{i.title}</b>}
          {i.body && <p style={{ whiteSpace: 'pre-wrap' }}>{i.body}</p>}
          {i.imageUrl && <img src={i.imageUrl} alt="" className="feed-photo" />}
          {i.reasons.length > 0 && <p className="small">Held for: {i.reasons.join('; ')}</p>}
          {i.reports.length > 0 && <p className="small">Reports: {i.reports.join(' · ')}</p>}
          <div className="row">
            {i.kind !== 'profile' && (
              <button className="btn small" onClick={() => act(i.kind, i.id, 'approve')}>
                Approve
              </button>
            )}
            {i.kind !== 'profile' && (
              <button className="btn small ghost" onClick={() => act(i.kind, i.id, 'remove')}>
                Remove
              </button>
            )}
            {i.kind === 'profile' && (
              <button className="btn small ghost" onClick={() => act(i.kind, i.id, 'dismiss')}>
                Dismiss
              </button>
            )}
            <button className="btn small danger" onClick={() => act(i.kind, i.id, 'strike')}>
              {i.kind === 'profile' ? 'Strike' : 'Remove + strike'}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
