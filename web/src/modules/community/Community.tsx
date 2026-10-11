/**
 * The Village (parents forum) and The Feed (social), grown-ups 18+ only.
 * Kids and teens have no nav entry and the API answers them 403.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  COMMUNITY_SAFETY_LINE,
  CRISIS_RESOURCES,
  VILLAGE_CATEGORIES,
  type CommunityAuthor,
  type CommunityMe,
  type CommunityQueue,
  type CommunityQueueItem,
  type PostCheck,
  type TrustedAnswer,
  type ReviewNote,
  type VillageCategory,
  type VillagePost,
  type VillageThread,
  type VillageThreadSummary,
  type VillageInfo,
} from '@myday/shared';
import { api, ApiFail, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { HanaFace } from '../../components/NavIcon';
import { ago } from '../../dates';
import { shrink } from '../health/ProgressPhotos';
import { count } from '../../format';
import { useSession } from '../../session';
import { FeedNav } from '../social/Social';
import { FeedTitle } from '../social/shell';
import { FeedOnboarding } from '../social/Onboarding';
import { VillageInvite } from '../social/Growth';
import { FEED_APP } from '../../apps';

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

export function CheckNote({ c }: { c: PostCheck }) {
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
export function VerifyButton({ kind, id, onCheck }: { kind: 'feed' | 'village'; id: number; onCheck: (c: PostCheck) => void }) {
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

export function TrustedCard({ t, testid = 'trusted-answer' }: { t: TrustedAnswer; testid?: string }) {
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
  // Checked at sign-up (the Feed app)? Then nobody asks twice.
  const askDob = !me.birthDateOnFile;
  const needDob = !session.member && askDob;
  const [f, setF] = useState({ displayName: '', bio: '', parentBadge: !!session.member, adult: false, guidelines: false, dob: '', username: '' });
  const [msg, setMsg] = useState<string | null>(null);
  // @username: required in the Feed app (how people find you), checked as you type.
  const [nameCheck, setNameCheck] = useState<{ available: boolean; reason?: string } | null>(null);
  useEffect(() => {
    const u = f.username.trim().replace(/^@/, '').toLowerCase();
    if (!u) {
      setNameCheck(null);
      return;
    }
    const t = setTimeout(() => {
      void api<{ available: boolean; reason?: string }>(`/api/feed/username?u=${encodeURIComponent(u)}`).then(setNameCheck, () => setNameCheck(null));
    }, 300);
    return () => clearTimeout(t);
  }, [f.username]);
  return (
    <form
      className="card form"
      data-testid="community-setup"
      onSubmit={(e) => {
        e.preventDefault();
        void api('/api/community/profile', 'PUT', { ...f, dob: f.dob || undefined, username: f.username.trim() || undefined })
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
        Username{FEED_APP ? '' : ' (optional)'} — how people find you
        <span className="at-input">
          <span aria-hidden="true">@</span>
          <input
            value={f.username}
            onChange={(e) => setF({ ...f, username: e.target.value.replace(/\s/g, '').toLowerCase() })}
            required={FEED_APP}
            maxLength={21}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-testid="setup-username"
          />
        </span>
        {nameCheck && (
          <small className={nameCheck.available ? 'good' : 'error'} role="status" data-testid="username-check">
            {nameCheck.available ? 'Available' : nameCheck.reason}
          </small>
        )}
      </label>
      <label>
        A short bio (optional — no kids’ names or schools)
        <input value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={280} />
      </label>
      {askDob && (
        <label>
          Date of birth{needDob ? '' : ' (optional)'} — only your age shows, never the date
          <input type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} required={needDob} max={new Date().toISOString().slice(0, 10)} data-testid="setup-dob" />
        </label>
      )}
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
      <button className="btn" disabled={!f.adult || !f.guidelines || (FEED_APP && nameCheck?.available === false)}>
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
      {!data.profile ? <Setup me={data} onDone={reload} /> : FEED_APP && !data.onboarded ? <FeedOnboarding onDone={reload} /> : children(data)}
    </>
  );
}

/* ---------- The Village ---------- */

export function Village() {
  return (
    <section data-testid="village" className="feed-page">
      <FeedTitle>Villages</FeedTitle>
      <FeedNav />
      <Gate>{(me) => <VillageList me={me} />}</Gate>
    </section>
  );
}

const VILLAGE_KEY = 'myday.village';

function VillageList({ me }: { me: CommunityMe }) {
  const [cat, setCat] = useState<VillageCategory | ''>('');
  const villages = useLoad<{ villages: VillageInfo[] }>('/api/villages');
  const [params] = useSearchParams();
  const [village, setVillageState] = useState<string>(() => {
    const v = params.get('v');
    if (v && /^[a-z0-9-]{2,40}$/.test(v)) return v;
    try {
      return localStorage.getItem(VILLAGE_KEY) ?? 'adhd-parents';
    } catch {
      return 'adhd-parents';
    }
  });
  const [inviting, setInviting] = useState(false);
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
      {here && (
        <div className="village-head" data-testid="village-head">
          <p className="muted small grow">
            {here.description} Grown-ups only, first names only. {count(here.members, 'member')}.
          </p>
          <button
            type="button"
            className={here.joined ? 'btn small' : 'btn ghost small'}
            aria-pressed={here.joined}
            onClick={() => void (here.joined ? api(`/api/villages/${here.slug}/members`, 'DELETE') : api(`/api/villages/${here.slug}/members`, 'POST')).then(() => villages.reload())}
            data-testid="village-join"
          >
            {here.joined ? 'Joined' : 'Join'}
          </button>
          <button type="button" className="btn ghost small" onClick={() => setInviting(true)} data-testid="village-invite-open">
            Invite
          </button>
        </div>
      )}
      {inviting && here && <VillageInvite slug={here.slug} onClose={() => setInviting(false)} />}
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

/** The quiet "…" menu: report or delete live here, out of the way. */
export function SlipMenu({ children }: { children: ReactNode }) {
  return (
    <details className="slip-menu">
      <summary aria-label="More">⋯</summary>
      <div className="slip-menu-pop">{children}</div>
    </details>
  );
}

/** A post's words with #topics and @names as links (to search). */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/((?:^|(?<=[^\w#&@]))[#@][a-z0-9_.]{2,30})/gi);
  return (
    <>
      {parts.map((part, i) =>
        /^[#@][a-z0-9_.]{2,30}$/i.test(part) ? (
          <Link key={i} to={`/search?q=${encodeURIComponent(part.replace(/\.$/, ''))}`} className="tag-link">
            {part}
          </Link>
        ) : (
          part
        ),
      )}
    </>
  );
}

export const STATE_NAMES: Record<string, string> = Object.fromEntries(
  'AL Alabama|AK Alaska|AZ Arizona|AR Arkansas|CA California|CO Colorado|CT Connecticut|DE Delaware|DC District of Columbia|FL Florida|GA Georgia|HI Hawaii|ID Idaho|IL Illinois|IN Indiana|IA Iowa|KS Kansas|KY Kentucky|LA Louisiana|ME Maine|MD Maryland|MA Massachusetts|MI Michigan|MN Minnesota|MS Mississippi|MO Missouri|MT Montana|NE Nebraska|NV Nevada|NH New Hampshire|NJ New Jersey|NM New Mexico|NY New York|NC North Carolina|ND North Dakota|OH Ohio|OK Oklahoma|OR Oregon|PA Pennsylvania|RI Rhode Island|SC South Carolina|SD South Dakota|TN Tennessee|TX Texas|UT Utah|VT Vermont|VA Virginia|WA Washington|WV West Virginia|WI Wisconsin|WY Wyoming|PR Puerto Rico'
    .split('|')
    .map((x) => [x.slice(0, 2), x.slice(3)]),
);

/** An icon for each achievement (the About tab's tiles). */
export const ACHIEVEMENT_ICON: Record<string, string> = { early: 'star', streak: 'flame', photo: 'camera', clips: 'share', helper: 'heart-hands', provider: 'shield' };

const KIND_LABEL: Record<CommunityQueueItem['kind'], string> = {
  village: 'Village',
  feed: 'Feed',
  image: 'Photo',
  profile: 'Profile',
  story: 'Story',
  clip: 'Clip',
  'clip-comment': 'Clip comment',
  'post-comment': 'Comment',
  message: 'Message',
};

interface ProviderReviewItem {
  userId: number;
  displayName: string | null;
  legalName: string;
  registryName: string | null;
  nameScore: number | null;
  npi: string;
  specialty: string;
  reason: string | null;
  badge: string;
  submittedAt: string;
}

/** Provider Knowledge Base: fuzzy name matches, possible OIG name matches, and paused badges wait here. */
function ProviderReviewQueue() {
  const { data, reload } = useLoad<{ providers: ProviderReviewItem[] }>('/api/providers/review');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return null;
  const act = (id: number, decision: 'verify' | 'reject' | 'reinstate', reason?: string): void =>
    void api(`/api/providers/${id}/decision`, 'POST', { decision, reason })
      .then(() => {
        setMsg(decision === 'verify' ? 'Verified — the badge is live.' : decision === 'reinstate' ? 'Badge reinstated.' : 'Rejected — they’ve been told why.');
        reload();
      })
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Could not save'));
  return (
    <section className="card" data-testid="provider-review-queue">
      <h2>Provider background — needs a person</h2>
      {msg && <p className="small muted">{msg}</p>}
      {!data.providers.length && <p className="muted small">Nothing waiting.</p>}
      {data.providers.map((p) => (
        <div key={p.userId} className="slip" data-testid="provider-review-item">
          <b>{p.legalName}</b> {p.displayName && <small className="muted">({p.displayName} on the Feed)</small>}
          <p className="small">
            NPI {p.npi} · {p.specialty} · NPI Registry name: <b>{p.registryName ?? '—'}</b>
            {p.nameScore !== null && ` (match ${Math.round(p.nameScore * 100)}%)`}
          </p>
          <p className="small muted">{p.reason ?? (p.badge === 'suspended' ? 'Badge paused (solicitation warning)' : '')}</p>
          <div className="row">
            {p.badge === 'suspended' && !p.reason ? (
              <button type="button" className="btn small" onClick={() => act(p.userId, 'reinstate')} data-testid="provider-reinstate">
                Reinstate badge
              </button>
            ) : (
              <>
                <button type="button" className="btn small" onClick={() => act(p.userId, 'verify')} data-testid="provider-verify">
                  Verify
                </button>
                <button type="button" className="btn ghost small" onClick={() => act(p.userId, 'reject', 'name mismatch')} data-testid="provider-reject">
                  Reject (name mismatch)
                </button>
                <button type="button" className="link danger small" onClick={() => act(p.userId, 'reject', 'excluded')}>
                  Reject (excluded)
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </section>
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
      <ProviderReviewQueue />
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
