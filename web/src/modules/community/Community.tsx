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
  type ClipItem,
  type CommunityAuthor,
  type CommunityMe,
  type CommunityProfile,
  type CommunityQueue,
  type CommunityQueueItem,
  type FeedPage,
  type FeedPost,
  type PostCheck,
  type ProviderSubmission,
  type TrustedAnswer,
  type ReviewNote,
  type VillageCategory,
  type VillagePost,
  type VillageThread,
  type VillageThreadSummary,
  type VillageInfo,
  type WebItem,
} from '@myday/shared';
import { api, ApiFail, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { HanaFace } from '../../components/NavIcon';
import { ago } from '../../dates';
import { shrink } from '../health/ProgressPhotos';
import { count } from '../../format';
import { useSession } from '../../session';
import { FeedNav, StoryRail } from '../social/Social';

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

export function ReviewBanner({ note }: { note: ReviewNote | null }) {
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

export function Who({ a }: { a: CommunityAuthor }) {
  return (
    <Link to={`/people/${a.userId}`} className="who-chip">
      {a.avatarUrl ? <img src={a.avatarUrl} alt="" className="avatar" width={28} height={28} /> : <span className="avatar blank" aria-hidden="true">{a.displayName.slice(0, 1)}</span>}
      <b>{a.displayName}</b>
      {a.parentBadge && <span className="pill">parent</span>}
    </Link>
  );
}

const REPORT_REASONS = ['Medical or dosage advice', 'Personal info about a kid or family', 'Unkind or attacking', 'Spam or selling', 'Someone may be in danger', 'Something else'];

export function ReportButton({ path, onDone }: { path: string; onDone: (msg: string) => void }) {
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
export async function uploadPhoto(file: File): Promise<{ id: number; url: string; review: ReviewNote }> {
  return uploadImage(await shrink(file));
}

/** An already-encoded JPEG (e.g. a frame taken from a clip), screened like any photo. */
export async function uploadImage(body: Blob): Promise<{ id: number; url: string; review: ReviewNote }> {
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

/* ---------- Trusted Answers ---------- */

/** A post that wasn't posted: why, and how to say it instead. The text stays in the box. */
export interface Blocked {
  explain: string;
  rephrase: string | null;
}
export function blockedOf(e: unknown): Blocked | null {
  if (e instanceof ApiFail && e.code === 'blocked') return { explain: e.message, rephrase: typeof e.details?.rephrase === 'string' ? e.details.rephrase : null };
  return null;
}
export function BlockedNote({ b }: { b: Blocked | null }) {
  if (!b) return null;
  return (
    <div className="blocked-note" role="alert" data-testid="blocked-note">
      <b>We didn’t post this — yet.</b>
      <p>{b.explain}</p>
      {b.rephrase && (
        <p className="small">
          <b>Try saying it like this:</b> {b.rephrase}
        </p>
      )}
      <p className="small muted">Your words are still in the box — edit them and post again.</p>
    </div>
  );
}

const VERDICT: Record<PostCheck['verdict'], string> = {
  supported: 'Backed by trusted sources',
  mixed: 'Partly — it depends',
  unsupported: 'Not backed by evidence',
  personal: 'Personal experience',
  no_claim: 'Nothing to fact-check',
};

function Sources({ list }: { list: TrustedAnswer['sources'] }) {
  if (!list.length) return null;
  return (
    <ul className="src-list">
      {list.map((s) => (
        <li key={`${s.label}${s.url ?? ''}`}>
          {s.url ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.label} ↗
            </a>
          ) : (
            s.label
          )}
        </li>
      ))}
    </ul>
  );
}

function CheckNote({ c }: { c: PostCheck }) {
  return (
    <aside className={`check-note v-${c.verdict}`} data-testid="hana-check">
      <span className="check-head">
        <HanaFace size={22} /> Hana checked · <b>{VERDICT[c.verdict]}</b>
      </span>
      <b className="check-headline">{c.headline}</b>
      <p>{c.explanation}</p>
      <Sources list={c.sources} />
    </aside>
  );
}

/** One tap: Hana fact-checks the post, inline, for everyone. */
function VerifyButton({ kind, id, onCheck }: { kind: 'feed' | 'village'; id: number; onCheck: (c: PostCheck) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="verify-btn"
        disabled={busy}
        data-testid="verify-hana"
        onClick={() => {
          setBusy(true);
          setErr(null);
          void api<{ check: PostCheck }>('/api/community/verify', 'POST', { kind, id })
            .then((r) => onCheck(r.check))
            .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Hana couldn’t check this one'))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Hana is checking…' : 'Verify with Hana'}
      </button>
      {err && <span className="small error">{err}</span>}
    </>
  );
}

function TrustedCard({ t, testid = 'trusted-answer' }: { t: TrustedAnswer; testid?: string }) {
  return (
    <section className="trusted" data-testid={testid}>
      <span className="trusted-label">
        {t.source === 'hana' ? <HanaFace size={22} /> : <span className="trusted-pin" aria-hidden="true" />}
        Trusted answer · {t.source === 'moderator' ? 'marked by a moderator' : t.source === 'publisher' ? `from ${t.by}` : 'from Hana'}
      </span>
      <p>{t.body}</p>
      <Sources list={t.sources} />
      {t.source !== 'moderator' && <small className="muted">Not medical advice — talk with your doctor about treatment decisions.</small>}
    </section>
  );
}

/* ---------- the gate: profile, guidelines, 18+ ---------- */

function Setup({ me, onDone }: { me: CommunityMe; onDone: () => void }) {
  const { me: session } = useSession();
  // People who joined just for the Feed confirm their date of birth (18+); the feed shows age only.
  const needDob = !session.member;
  const [f, setF] = useState({ displayName: '', bio: '', parentBadge: !needDob, adult: false, guidelines: false, dob: '' });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="card form"
      data-testid="community-setup"
      onSubmit={(e) => {
        e.preventDefault();
        void api('/api/community/profile', 'PUT', { ...f, dob: f.dob || undefined })
          .then(onDone)
          .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not save'));
      }}
    >
      <h2>Join the Feed</h2>
      <p className="small">The Feed is a calm community for adults (18+) living with ADHD — and the people who love them. It’s free. Please read these first:</p>
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
      <label>
        Date of birth{needDob ? '' : ' (optional)'} — only your age shows, never the date
        <input type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} required={needDob} max={new Date().toISOString().slice(0, 10)} data-testid="setup-dob" />
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

export function Gate({ children }: { children: (me: CommunityMe) => ReactNode }) {
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
    <section data-testid="village" className="feed-page">
      <h1>Villages</h1>
      <FeedNav />
      <Gate>{(me) => <VillageList me={me} />}</Gate>
    </section>
  );
}

const VILLAGE_KEY = 'myday.village';

function VillageList({ me }: { me: CommunityMe }) {
  const [cat, setCat] = useState<VillageCategory | ''>('');
  const villages = useLoad<{ villages: VillageInfo[] }>('/api/villages');
  const [village, setVillageState] = useState<string>(() => {
    try {
      return localStorage.getItem(VILLAGE_KEY) ?? 'adhd-parents';
    } catch {
      return 'adhd-parents';
    }
  });
  const setVillage = (v: string): void => {
    setVillageState(v);
    try {
      localStorage.setItem(VILLAGE_KEY, v);
    } catch {
      /* per-device convenience */
    }
  };
  const here = villages.data?.villages.find((v) => v.slug === village);
  const { data, reload } = useLoad<{ threads: VillageThreadSummary[] }>(`/api/village?village=${encodeURIComponent(village)}${cat ? `&category=${cat}` : ''}`);
  const [f, setF] = useState({ category: 'wins' as VillageCategory, title: '', body: '' });
  const [review, setReview] = useState<ReviewNote | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  return (
    <>
      {me.isModerator && (
        <p>
          <Link to="/community/moderation">Moderation queue →</Link>
        </p>
      )}
      <div className="village-switch" role="group" aria-label="Village" data-testid="village-switch">
        {villages.data?.villages.map((v) => (
          <button key={v.slug} type="button" className={v.slug === village ? 'village-pick on' : 'village-pick'} aria-pressed={v.slug === village} onClick={() => setVillage(v.slug)} data-testid={`village-${v.slug}`}>
            <b>{v.name}</b>
            <small>{count(v.threads, 'conversation')}</small>
          </button>
        ))}
      </div>
      {here && <p className="muted small">{here.description} Grown-ups only, first names only.</p>}
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
              {t.answered && <span className="pill answered">Answered ✓</span>}
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
            <b>Start a conversation{here ? ` in ${here.name}` : ''}</b>
          </summary>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              setMsg(null);
              setBlocked(null);
              void api<{ review: ReviewNote }>('/api/village/threads', 'POST', { ...f, village })
                .then((r) => {
                  setReview(r.review);
                  setF({ ...f, title: '', body: '' });
                  reload();
                })
                .catch((e2: unknown) => (blockedOf(e2) ? setBlocked(blockedOf(e2)) : setMsg(e2 instanceof Error ? e2.message : 'Could not post')));
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
            <BlockedNote b={blocked} />
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
    <section data-testid="village-thread" className="feed-page">
      <FeedNav />
      <p>
        <Link to="/village">← Villages</Link>
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
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const [opening, ...replies] = data.posts;
  const setCheck = (id: number, c: PostCheck): void => setData({ ...data, posts: data.posts.map((p) => (p.id === id ? { ...p, check: c } : p)) });
  return (
    <>
      <h1>{data.title}</h1>
      <small className="muted">{VILLAGE_CATEGORIES.find((c) => c.key === data.category)?.label}</small>
      <ReviewBanner note={review} />
      {msg && <p className="muted" role="status">{msg}</p>}
      {opening && <VPost p={opening} onThread={setData} onMsg={setMsg} onCheck={setCheck} me={me} />}
      {data.trusted && <TrustedCard t={data.trusted} />}
      {data.isQuestion && !data.trusted && data.status === 'visible' && <p className="small muted desk-note">Hana is looking for a trusted answer — it pins here when it’s ready.</p>}
      {replies.length > 0 && <h2 className="replies-head">Replies</h2>}
      {replies.map((p) => (
        <VPost key={p.id} p={p} onThread={setData} onMsg={setMsg} onCheck={setCheck} me={me} isTrusted={data.trusted?.replyPostId === p.id} />
      ))}
      {data.status === 'visible' && !me.mutedUntil && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            setBlocked(null);
            void api<{ thread: VillageThread; review: ReviewNote }>(`/api/village/threads/${data.id}/replies`, 'POST', { body: reply })
              .then((r) => {
                setData(r.thread);
                setReview(r.review);
                setReply('');
              })
              .catch((e2: unknown) => (blockedOf(e2) ? setBlocked(blockedOf(e2)) : setMsg(e2 instanceof Error ? e2.message : 'Could not reply')));
          }}
        >
          <textarea aria-label="Reply" placeholder="Reply kindly…" value={reply} onChange={(e) => setReply(e.target.value)} required maxLength={5000} rows={3} />
          <BlockedNote b={blocked} />
          <button className="btn small">Reply</button>
        </form>
      )}
    </>
  );
}

function VPost({
  p,
  onThread,
  onMsg,
  onCheck,
  me,
  isTrusted = false,
}: {
  p: VillagePost;
  onThread: (t: VillageThread) => void;
  onMsg: (m: string) => void;
  onCheck: (id: number, c: PostCheck) => void;
  me: CommunityMe;
  isTrusted?: boolean;
}) {
  const confirm = useConfirm();
  const react = (kind: 'heart' | 'been-there'): void => void api<VillageThread>(`/api/village/posts/${p.id}/react`, 'POST', { kind }).then(onThread);
  return (
    <div className={`card${p.opening ? ' opening' : ''}${isTrusted ? ' is-trusted' : ''}`} data-testid="village-post">
      <div className="row">
        <span className="grow">
          <Who a={p.author} />
        </span>
        {p.status !== 'visible' && <span className="pill sun">under review</span>}
        <small className="muted">{ago(p.at)}</small>
      </div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{p.body}</p>
      {p.check && <CheckNote c={p.check} />}
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
      {p.status === 'visible' && !p.check && (
        <div className="row">
          <VerifyButton kind="village" id={p.id} onCheck={(c) => onCheck(p.id, c)} />
        </div>
      )}
      {me.isModerator && !p.opening && p.status === 'visible' && !isTrusted && (
        <button className="link small" data-testid="mark-trusted" onClick={() => void api<VillageThread>(`/api/village/posts/${p.id}/trusted`, 'POST').then(onThread)}>
          Mark as the trusted answer
        </button>
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

/* ---------- The Feed: paper slips on a desk ---------- */

/** A small, steady tilt per post, so the desk looks hand-laid (same tilt every visit). */
const tilt = (id: number): string => `${(((id * 37) % 9) - 4) * 0.14}deg`;

/** Crumpled paper: only for empty states. */
function Crumple() {
  return (
    <svg className="crumple" viewBox="0 0 120 100" aria-hidden="true">
      <path d="M22 58c-6-14 4-30 18-34 6-10 22-14 32-6 14-2 26 8 26 22 10 8 8 26-4 32-4 12-20 16-30 10-10 8-28 6-34-4-12 0-16-12-8-20z" />
      <path d="M40 30l10 14 14-10 6 18 16-4M30 56l18-6 8 14 18-8 10 12M52 44l-4 18M70 50l4 16M44 70l12-6" />
    </svg>
  );
}

export function EmptySheet({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="fresh-sheet" data-testid="feed-empty">
      <Crumple />
      <b>{title}</b>
      {children && <p className="small muted">{children}</p>}
    </div>
  );
}

export function Feed() {
  return (
    <section data-testid="feed" className="feed-page">
      <h1>The Feed</h1>
      <FeedNav />
      <Gate>{(me) => <FeedBody me={me} />}</Gate>
    </section>
  );
}

type FeedTab = 'following' | 'everyone' | 'web';
const TAB_LABEL: Record<FeedTab, string> = { following: 'Following', everyone: 'Everyone', web: 'Around the Web' };

function FeedBody({ me }: { me: CommunityMe }) {
  const [tab, setTab] = useState<FeedTab>('everyone');
  const [review, setReview] = useState<ReviewNote | null>(null);
  const [posted, setPosted] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <p className="feed-links">
        <Link to={`/people/${me.profile?.userId ?? ''}`}>Your card →</Link>
        {me.isModerator && (
          <>
            {' · '}
            <Link to="/community/moderation">Moderation queue →</Link>
          </>
        )}
      </p>
      <StoryRail me={me} />
      <div className="fdesk" data-testid="feed-desk">
        <nav className="desk-tabs" aria-label="Feed">
          {(['following', 'everyone', 'web'] as const).map((t) => (
            <button key={t} className={tab === t ? 'desk-tab on' : 'desk-tab'} aria-pressed={tab === t} onClick={() => setTab(t)} data-testid={`feed-tab-${t}`}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </nav>
        {tab !== 'web' && !me.mutedUntil && (
          <Composer
            onPosted={(r) => {
              setReview(r);
              setPosted((n) => n + 1);
            }}
          />
        )}
        <ReviewBanner note={review} />
        {msg && <p className="desk-note" role="status">{msg}</p>}
        {tab === 'web' ? <WebTab /> : <Posts key={`${tab}-${posted}`} tab={tab} onMsg={setMsg} />}
      </div>
    </>
  );
}

function Posts({ tab, onMsg }: { tab: 'following' | 'everyone'; onMsg: (m: string) => void }) {
  const { data, setData, reload } = useLoad<FeedPage>(`/api/feed?tab=${tab}`);
  if (!data) return <p className="muted desk-note">Laying out the desk…</p>;
  const replace = (p: FeedPost): void => setData({ ...data, posts: data.posts.map((x) => (x.id === p.id ? p : x)) });
  if (!data.posts.length) {
    return tab === 'following' ? (
      <EmptySheet title="Nobody you follow has written this week">Tap a name on Everyone to follow people — their notes land here.</EmptySheet>
    ) : (
      <EmptySheet title="Fresh sheet — be the first to write">A win, a strategy, a laugh. Someone out there needs it today.</EmptySheet>
    );
  }
  return (
    <div className="slips" data-testid="feed-posts">
      {data.posts.map((p) => (
        <FeedCard key={p.id} p={p} onChange={replace} onMsg={onMsg} onGone={() => reload()} />
      ))}
      <CaughtUp days={data.windowDays} />
    </div>
  );
}

/** The end of the Feed — a stopping cue, on purpose. */
function CaughtUp({ days }: { days: number }) {
  return (
    <div className="caught-up" role="status" data-testid="feed-caught-up">
      <span className="caught-check" aria-hidden="true">
        ✓
      </span>
      <b>You’re caught up</b>
      <p className="small">That’s everything from the last {count(days, 'day')}. Go do something kind for yourself — the desk will be here.</p>
    </div>
  );
}

function WebTab() {
  const { data, error } = useLoad<{ items: WebItem[] }>('/api/feed/web');
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted desk-note">Gathering clippings…</p>;
  if (!data.items.length) return <EmptySheet title="No clippings yet">Articles from ADHD publishers land here a few times a day.</EmptySheet>;
  return (
    <div className="slips" data-testid="web-items">
      <p className="desk-note small">From trusted ADHD publishers. Each one opens on the publisher’s own site.</p>
      {data.items.map((w) => (
        <a key={w.id} href={w.url} target="_blank" rel="noopener noreferrer" className="clipping" style={{ ['--tilt' as string]: tilt(w.id) }} data-testid="web-item">
          <span className="publisher-label">{w.publisher}</span>
          <b className="clip-title">{w.title}</b>
          {w.summary && <span className="clip-sum">{w.summary}</span>}
          <span className="clip-foot">
            {ago(w.publishedAt)} · Read on {w.publisher} ↗
          </span>
        </a>
      ))}
      <CaughtUp days={90} />
    </div>
  );
}

function Composer({ onPosted }: { onPosted: (r: ReviewNote) => void }) {
  const [body, setBody] = useState('');
  const [photo, setPhoto] = useState<{ id: number; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  return (
    <form
      className="sheet-compose"
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        setBlocked(null);
        void api<{ review: ReviewNote }>('/api/feed/posts', 'POST', { body, imageId: photo?.id ?? null })
          .then((r) => {
            setBody('');
            setPhoto(null);
            onPosted(r.review);
          })
          .catch((e2: unknown) => (blockedOf(e2) ? setBlocked(blockedOf(e2)) : setMsg(e2 instanceof Error ? e2.message : 'Could not post')));
      }}
    >
      <textarea aria-label="Share something" placeholder="A win, a strategy, a laugh…" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={3} />
      {photo && <img src={photo.url} alt="Your photo" className="feed-photo taped" />}
      <div className="row">
        <label className="link small">
          {busy ? 'Adding…' : photo ? 'Change photo' : '+ Photo'}
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
        <small className="muted grow">No kids’ faces, names or schools. Checked before it appears.</small>
        <button className="btn small" disabled={busy || (!body.trim() && !photo)}>
          Post
        </button>
      </div>
      <BlockedNote b={blocked} />
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
    </form>
  );
}

/** Like = a rubber stamp: it slams down when you press it. */
function Stamp({ p, onChange }: { p: FeedPost; onChange: (p: FeedPost) => void }) {
  const [slam, setSlam] = useState(false);
  return (
    <button
      className={`ink-stamp${p.likedByMe ? ' on' : ''}${slam ? ' slam' : ''}`}
      aria-label={p.likedByMe ? 'Unlike' : 'Like'}
      aria-pressed={p.likedByMe}
      onAnimationEnd={() => setSlam(false)}
      onClick={() => {
        if (!p.likedByMe) setSlam(true);
        void api<FeedPost>(`/api/feed/posts/${p.id}/like`, 'POST').then(onChange);
      }}
    >
      <span className="stamp-face" aria-hidden="true">
        ♥
      </span>
      {p.likes > 0 && <span className="stamp-count">{p.likes}</span>}
    </button>
  );
}

/** The quiet "…" menu: report or delete live here, out of the way. */
export function SlipMenu({ children }: { children: ReactNode }) {
  return (
    <details className="slip-menu">
      <summary aria-label="More">⋯</summary>
      <div className="slip-menu-pop">{children}</div>
    </details>
  );
}

export function FeedCard({ p, onChange, onMsg, onGone }: { p: FeedPost; onChange: (p: FeedPost) => void; onMsg: (m: string) => void; onGone: (id: number) => void }) {
  const confirm = useConfirm();
  return (
    <article className="slip" style={{ ['--tilt' as string]: tilt(p.id) }} data-testid="feed-post">
      <header className="slip-head">
        <Who a={p.author} />
        <small className="muted">{ago(p.at)}</small>
        {p.status !== 'visible' && <span className="pill sun">under review</span>}
      </header>
      {p.body && <p className="slip-body">{p.body}</p>}
      {p.imageUrl && <img src={p.imageUrl} alt="" className="feed-photo taped" loading="lazy" />}
      {p.trusted && <TrustedCard t={p.trusted} />}
      {p.isQuestion && !p.trusted && p.status === 'visible' && <p className="small muted">Hana is looking for a trusted answer…</p>}
      {p.check && <CheckNote c={p.check} />}
      <footer className="slip-foot">
        {p.status === 'visible' && <Stamp p={p} onChange={onChange} />}
        {p.status === 'visible' && !p.check && p.body && <VerifyButton kind="feed" id={p.id} onCheck={(c) => onChange({ ...p, check: c })} />}
        <span className="grow" />
        <SlipMenu>
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
        </SlipMenu>
      </footer>
    </article>
  );
}

/* ---------- people: an index card, not a cover photo ---------- */

export function PersonPage() {
  const { id } = useParams();
  return (
    <section data-testid="person" className="feed-page">
      <p>
        <Link to="/feed">← The Feed</Link>
      </p>
      <Gate>{() => <Person id={id ?? ''} />}</Gate>
    </section>
  );
}

const PROFILE_TABS = [
  { key: 'posts', label: 'Posts' },
  { key: 'clips', label: 'Clips' },
  { key: 'about', label: 'About' },
] as const;
type ProfileTab = (typeof PROFILE_TABS)[number]['key'];

const feetInches = (inches: number): string => `${Math.floor(inches / 12)}′ ${Math.round(inches % 12)}″`;

function Person({ id }: { id: string }) {
  const { data, error, setData } = useLoad<CommunityProfile>(`/api/community/people/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState<ProfileTab>('posts');
  const posts = useLoad<FeedPage>(tab === 'posts' ? `/api/feed?author=${encodeURIComponent(id)}` : null);
  const clips = useLoad<{ clips: ClipItem[] }>(tab === 'clips' ? `/api/social/clips?user=${encodeURIComponent(id)}` : null);
  const [list, setList] = useState<'followers' | 'following' | null>(null);
  const people = useLoad<{ people: CommunityAuthor[] }>(list ? `/api/community/people/${encodeURIComponent(id)}/${list}` : null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const since = new Date(`${data.joinedOn}T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const pro = data.provider;
  const verifiedOn = pro ? new Date(pro.verifiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return (
    <>
      <article className={pro ? 'profile-hero provider' : 'profile-hero'} data-testid="profile-card">
        <div className="profile-band" aria-hidden="true" />
        <div className="profile-avatar">
          {data.avatarUrl ? <img src={data.avatarUrl} alt={`${data.displayName}’s photo`} /> : <span>{data.displayName.slice(0, 1)}</span>}
        </div>
        <h1 className="profile-name">{data.displayName}</h1>
        {pro && (
          <>
            <span className="provider-badge" data-testid="provider-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" fill="currentColor" />
                <path d="m8.5 12 2.4 2.4L15.8 9.6" fill="none" stroke="#1b1205" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Verified licensed provider
            </span>
            <p className="provider-type">{pro.licenseType}</p>
          </>
        )}
        {!pro && data.parentBadge && <span className="badge-stamp">Parent</span>}
        {data.bio ? <p className="profile-bio">{data.bio}</p> : data.me && <p className="profile-bio muted">Add a line about you — no kids’ names or schools.</p>}
        <ul className="profile-stats" data-testid="follow-counts">
          <li>
            <button type="button" onClick={() => setList(list === 'followers' ? null : 'followers')} aria-expanded={list === 'followers'}>
              <b>{data.followers}</b>
              <small>Followers</small>
            </button>
          </li>
          <li>
            <span>
              <b>{data.posts + data.clips}</b>
              <small>Posts</small>
            </span>
          </li>
          <li>
            <span data-testid="profile-streak">
              <b>{data.streak}</b>
              <small>Day streak</small>
            </span>
          </li>
        </ul>
        <div className="profile-actions">
          {data.me ? (
            <button className="btn small ghost" onClick={() => setEditing(!editing)} data-testid="edit-profile">
              Edit profile
            </button>
          ) : (
            <>
              {pro && (
                <Link className="btn small gold" to={`/messages/${data.userId}?consult=1`} data-testid="book-consult">
                  Book consult
                </Link>
              )}
              {data.followedByMe ? (
                <button className="btn small ghost" onClick={() => void api<CommunityProfile>(`/api/community/people/${data.userId}/follow`, 'DELETE').then(setData)}>
                  Following ✓
                </button>
              ) : (
                <button className="btn small" onClick={() => void api<CommunityProfile>(`/api/community/people/${data.userId}/follow`, 'POST').then(setData)}>
                  Follow
                </button>
              )}
              <Link className="btn small ghost" to={`/messages/${data.userId}`} data-testid="profile-message">
                Message
              </Link>
              <SlipMenu>
                <ReportButton path={`/api/community/people/${data.userId}/report`} onDone={setMsg} />
                <button
                  className="link danger small"
                  onClick={() =>
                    void confirm({ title: `Block ${data.displayName}?`, body: 'You won’t see each other’s posts, and neither of you can follow or message the other.', confirmLabel: 'Block', danger: true }).then(
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
              </SlipMenu>
            </>
          )}
        </div>
        {data.shopUrl && (
          <a className="price-tag" href={data.shopUrl} target="_blank" rel="noopener noreferrer" data-testid="shop-slot">
            <span className="tag-hole" aria-hidden="true" />
            <span>
              <b>Shop</b>
              <small>{data.displayName}’s storefront ↗</small>
            </span>
          </a>
        )}
      </article>
      {pro && (
        <section className="provider-creds" data-testid="provider-credentials">
          <small className="label">Credentials</small>
          <dl>
            <div>
              <dt>License</dt>
              <dd>{pro.licenseType}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{pro.licenseState}</dd>
            </div>
            <div>
              <dt>License #</dt>
              <dd>{pro.licenseNumber}</dd>
            </div>
            <div>
              <dt>Verified</dt>
              <dd>{verifiedOn}</dd>
            </div>
          </dl>
          {pro.specialties.length > 0 && (
            <>
              <small className="label">Specialties</small>
              <p className="spec-chips">
                {pro.specialties.map((s) => (
                  <span key={s} className="spec-chip">
                    {s}
                  </span>
                ))}
              </p>
            </>
          )}
          <small className="muted">MyDay checked this license before the badge appeared. Posts are general information, not medical advice for you.</small>
        </section>
      )}
      {list && (
        <div className="slip people-list" data-testid="people-list">
          <div className="row">
            <b className="grow">{list === 'followers' ? 'Followers' : 'Following'}</b>
            <button type="button" className="link small" onClick={() => setList(list === 'followers' ? 'following' : 'followers')}>
              {list === 'followers' ? `Following (${data.following})` : `Followers (${data.followers})`}
            </button>
          </div>
          {people.data?.people.map((a) => (
            <p key={a.userId}>
              <Who a={a} />
            </p>
          ))}
          {people.data && !people.data.people.length && <p className="muted">Nobody yet.</p>}
        </div>
      )}
      {msg && <p className="desk-note" role="status">{msg}</p>}
      {editing && (
        <EditProfile
          p={data}
          onSaved={(p) => {
            setData(p);
            setEditing(false);
          }}
        />
      )}
      <nav className="desk-tabs profile-tabs" aria-label="Profile">
        {PROFILE_TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'desk-tab on' : 'desk-tab'} aria-pressed={tab === t.key} onClick={() => setTab(t.key)} data-testid={`profile-tab-${t.key}`}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'posts' && (
        <div className="fdesk">
          {posts.data && !posts.data.posts.length && <EmptySheet title="Nothing written yet" />}
          <div className="slips">
            {posts.data?.posts.map((p) => (
              <FeedCard key={p.id} p={p} onChange={() => posts.reload()} onMsg={setMsg} onGone={() => posts.reload()} />
            ))}
          </div>
        </div>
      )}
      {tab === 'clips' && (
        <div className="clip-grid" data-testid="profile-clips">
          {clips.data?.clips.map((c) => (
            <Link key={c.id} to={`/clips?user=${data.userId}&c=${c.id}`} className="clip-tile" data-testid="clip-tile">
              {c.posterUrl ? <img src={c.posterUrl} alt="" /> : <span className="clip-tile-blank" />}
              <small>▶ {c.views}</small>
            </Link>
          ))}
          {clips.data && !clips.data.clips.length && <p className="muted small">No clips yet.</p>}
        </div>
      )}
      {tab === 'about' && (
        <section className="profile-about" data-testid="profile-about">
          <dl>
            {data.age !== null && (
              <div>
                <dt>Age</dt>
                <dd data-testid="about-age">{data.age}</dd>
              </div>
            )}
            {data.heightIn !== null && (
              <div>
                <dt>Height</dt>
                <dd data-testid="about-height">{feetInches(data.heightIn)}</dd>
              </div>
            )}
            {data.location && (
              <div>
                <dt>Location</dt>
                <dd>{data.location}</dd>
              </div>
            )}
            <div>
              <dt>Member since</dt>
              <dd>{since}</dd>
            </div>
          </dl>
          {data.achievements.length > 0 && (
            <>
              <small className="label">Achievements</small>
              <p className="spec-chips" data-testid="achievements">
                {data.achievements.map((a) => (
                  <span key={a.key} className="achievement">
                    {a.label}
                  </span>
                ))}
              </p>
            </>
          )}
          {data.me && <small className="muted">Only your age shows here — never your date of birth.</small>}
        </section>
      )}
    </>
  );
}

const LICENSE_TYPES = [
  'Psychiatrist (MD/DO)',
  'Psychologist (PhD/PsyD)',
  'Psychiatric Nurse Practitioner (PMHNP)',
  'Licensed Clinical Social Worker (LCSW)',
  'Licensed Professional Counselor (LPC)',
  'Licensed Marriage & Family Therapist (LMFT)',
  'Pediatrician (MD/DO)',
  'Occupational Therapist (OT)',
  'Speech-Language Pathologist (SLP)',
];
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' ');

function EditProfile({ p, onSaved }: { p: CommunityProfile; onSaved: (p: CommunityProfile) => void }) {
  const [f, setF] = useState({
    displayName: p.displayName,
    bio: p.bio,
    parentBadge: p.parentBadge,
    shopSlug: p.shopSlug ?? '',
    dob: p.dob ?? '',
    feet: p.heightIn ? String(Math.floor(p.heightIn / 12)) : '',
    inches: p.heightIn ? String(Math.round(p.heightIn % 12)) : '',
    location: p.location ?? '',
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (extra: Record<string, unknown> = {}): void => {
    const height = f.feet ? Number(f.feet) * 12 + Number(f.inches || 0) : null;
    void api<CommunityProfile>('/api/community/profile', 'PUT', {
      displayName: f.displayName,
      bio: f.bio,
      parentBadge: f.parentBadge,
      shopSlug: f.shopSlug,
      dob: f.dob || null,
      heightIn: height,
      location: f.location.trim() || null,
      ...extra,
    })
      .then(onSaved)
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Could not save'));
  };
  return (
    <>
      <form
        className="slip form"
        data-testid="profile-edit"
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
        <label>
          Date of birth — private: your profile shows your age only
          <input type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} max={new Date().toISOString().slice(0, 10)} data-testid="edit-dob" />
        </label>
        <div className="row">
          <label className="grow">
            Height (feet)
            <input type="number" inputMode="numeric" min={3} max={8} value={f.feet} onChange={(e) => setF({ ...f, feet: e.target.value })} data-testid="edit-feet" />
          </label>
          <label className="grow">
            Inches
            <input type="number" inputMode="numeric" min={0} max={11} value={f.inches} onChange={(e) => setF({ ...f, inches: e.target.value })} data-testid="edit-inches" />
          </label>
        </div>
        <label>
          Location (optional — a city or state, never your address)
          <input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} maxLength={60} placeholder="e.g. Denver, CO" data-testid="edit-location" />
        </label>
        <label>
          Your MonetizeMe shop (optional — the name after ?slug= in your storefront link)
          <input value={f.shopSlug} onChange={(e) => setF({ ...f, shopSlug: e.target.value })} maxLength={60} placeholder="e.g. tys-planners" autoCapitalize="none" />
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
        <button className="btn small" data-testid="profile-save">
          Save
        </button>
      </form>
      <ProviderForm current={p.providerStatus ?? null} verified={!!p.provider} />
    </>
  );
}

/** Licensed clinicians: submit a license; MyDay verifies it before the provider page (and badge) exists. */
function ProviderForm({ current, verified }: { current: ProviderSubmission | null; verified: boolean }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(current);
  const [f, setF] = useState({
    licenseType: current?.licenseType ?? '',
    licenseState: current?.licenseState ?? '',
    licenseNumber: current?.licenseNumber ?? '',
    specialties: current?.specialties.join(', ') ?? '',
  });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <section className="slip form provider-form" data-testid="provider-form">
      <b>Are you a licensed provider?</b>
      {status?.status === 'verified' || (verified && !status) ? (
        <p className="small" data-testid="provider-status">
          ✓ Verified. Your profile shows the provider badge and your credentials. Changing them sends them back for review.
        </p>
      ) : status?.status === 'submitted' ? (
        <p className="small" data-testid="provider-status">
          Submitted — MyDay is checking your license. Your profile stays a regular profile until it’s verified.
        </p>
      ) : status?.status === 'rejected' ? (
        <p className="small error" data-testid="provider-status">
          We couldn’t verify that license{status.rejectReason ? `: ${status.rejectReason}` : ''}. Check the details and send it again.
        </p>
      ) : (
        <p className="small muted">Clinicians get a verified provider page — credentials, specialties, and a Book consult button — once MyDay checks the license.</p>
      )}
      {!open ? (
        <button type="button" className="btn small ghost" onClick={() => setOpen(true)} data-testid="provider-open">
          {status ? 'Update credentials' : 'Add your license'}
        </button>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            setMsg(null);
            const specialties = f.specialties
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
            void api<{ status: 'submitted' }>('/api/social/provider', 'PUT', { ...f, specialties })
              .then(() => {
                setStatus({ status: 'submitted', licenseType: f.licenseType, licenseState: f.licenseState, licenseNumber: f.licenseNumber, specialties, submittedAt: new Date().toISOString(), rejectReason: null });
                setOpen(false);
              })
              .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not submit'));
          }}
        >
          <label>
            License type
            <input list="license-types" value={f.licenseType} onChange={(e) => setF({ ...f, licenseType: e.target.value })} required maxLength={80} data-testid="provider-type" />
            <datalist id="license-types">
              {LICENSE_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <div className="row">
            <label>
              State
              <select value={f.licenseState} onChange={(e) => setF({ ...f, licenseState: e.target.value })} required data-testid="provider-state">
                <option value="">—</option>
                {US_STATES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="grow">
              License number
              <input value={f.licenseNumber} onChange={(e) => setF({ ...f, licenseNumber: e.target.value })} required maxLength={40} data-testid="provider-number" />
            </label>
          </div>
          <label>
            Specialties (up to 6, separated by commas)
            <input value={f.specialties} onChange={(e) => setF({ ...f, specialties: e.target.value })} placeholder="ADHD, Anxiety, Parent coaching" data-testid="provider-specialties" />
          </label>
          {msg && <p className="error">{msg}</p>}
          <button className="btn small" data-testid="provider-submit">
            Send for verification
          </button>
        </form>
      )}
    </section>
  );
}

/* ---------- moderation (MyDay admins) ---------- */

const KIND_LABEL: Record<CommunityQueueItem['kind'], string> = {
  village: 'Village',
  feed: 'Feed',
  image: 'Photo',
  profile: 'Profile',
  story: 'Story',
  clip: 'Clip',
  'clip-comment': 'Clip comment',
  message: 'Message',
};

interface ProviderQueueItem {
  userId: number;
  displayName: string | null;
  email: string;
  licenseType: string;
  licenseState: string;
  licenseNumber: string;
  specialties: string[];
  submittedAt: string;
}

/** Licenses waiting for a MyDay admin to check with the state board. */
function ProviderQueue() {
  const { data, reload } = useLoad<{ providers: ProviderQueueItem[] }>('/api/social/providers/queue');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data?.providers.length) return null;
  const act = (id: number, action: 'verify' | 'reject'): void =>
    void api(`/api/social/providers/${id}/${action}`, 'POST', {})
      .then(() => {
        setMsg(action === 'verify' ? 'Verified — their provider page is live.' : 'Rejected — they’ll see it and can resubmit.');
        reload();
      })
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Could not update'));
  return (
    <div className="card" data-testid="provider-queue">
      <h2>Provider licenses to verify</h2>
      <p className="small muted">Look the license up on the state board’s site before verifying.</p>
      {msg && <p role="status">{msg}</p>}
      {data.providers.map((p) => (
        <div key={p.userId} className="row provider-queue-item" data-testid="provider-queue-item">
          <span className="grow">
            <b>{p.displayName ?? '(no profile yet)'}</b> ({p.email}) · {p.licenseType} · {p.licenseState} #{p.licenseNumber}
            {p.specialties.length > 0 && <small className="muted"> · {p.specialties.join(', ')}</small>}
          </span>
          <button className="btn small" onClick={() => act(p.userId, 'verify')} data-testid="provider-verify">
            Verify
          </button>
          <button className="btn small ghost" onClick={() => act(p.userId, 'reject')}>
            Reject
          </button>
        </div>
      ))}
    </div>
  );
}

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
      <ProviderQueue />
      {msg && <p role="status">{msg}</p>}
      {!data.items.length && <p className="muted">The queue is empty.</p>}
      {data.items.map((i) => (
        <div key={`${i.kind}-${i.id}`} className={i.priority >= 2 ? 'card crisis' : 'card'} data-testid="queue-item">
          <div className="row">
            <b className="grow">
              {i.priority >= 2 && '⚠ '}
              {KIND_LABEL[i.kind]} · {i.author.displayName} ({i.author.email}) · {count(i.author.strikes, 'strike')}
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
