/**
 * The Feed's social sections: Stories, Clips and Messages, the section bar that ties them together
 * with the Feed, Circles and Villages, and the public landing page at /feed. Grown-ups (18+) only —
 * kids and teens have no route here and the API answers them 403. The Feed is free: nothing here
 * checks a subscription.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { ClipComment, ClipItem, CommunityAuthor, CommunityMe, ConsultSlot, DmThread, DmThreadSummary, ReviewNote, SponsoredItem, StoryItem, StoryRailItem } from '@myday/shared';
import { api, ApiFail, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { ago } from '../../dates';
import { count } from '../../format';
import { SignInChoices } from '../../Login';
import { FeedHorn, NavIcon } from '../../components/NavIcon';
import { AGE_KEY, FeedNav, FeedTitle, NEXT_KEY, store, stored } from './shell';

export { FeedNav };
import { blockedOf, BlockedNote, CrisisCard, Gate, ReportButton, ReviewBanner, SlipMenu, uploadImage, uploadPhoto, type Blocked } from '../community/Community';

/* ---------- small pieces ---------- */

function Avatar({ a, size = 44 }: { a: Pick<CommunityAuthor, 'avatarUrl' | 'displayName'>; size?: number }) {
  return a.avatarUrl ? (
    <img src={a.avatarUrl} alt="" className="s-avatar" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span className="s-avatar blank" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {a.displayName.slice(0, 1)}
    </span>
  );
}

const ICON: Record<string, ReactNode> = {
  heart: <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z" />,
  comment: <path d="M4.5 18.5V7a2.5 2.5 0 0 1 2.5-2.5h10A2.5 2.5 0 0 1 19.5 7v7a2.5 2.5 0 0 1-2.5 2.5H8.5z" />,
  share: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 8.5 12 4l4.5 4.5" />
      <path d="M5 13v5.5h14V13" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  sound: (
    <>
      <path d="M4 10v4h3.5L12 18V6L7.5 10z" />
      <path d="M15.5 9a4 4 0 0 1 0 6" />
      <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  muted: (
    <>
      <path d="M4 10v4h3.5L12 18V6L7.5 10z" />
      <path d="m16 9.5 5 5" />
      <path d="m21 9.5-5 5" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
};

function Icon({ name, size = 26, filled = false }: { name: keyof typeof ICON; size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[name]}
    </svg>
  );
}

const errText = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

/* ---------- the Feed's section bar ---------- */

/** A Feed page: the title, the section bar, then the community gate (profile, guidelines, 18+). */
function FeedSection({ title, testid, children }: { title: string; testid: string; children: (me: CommunityMe) => ReactNode }) {
  return (
    <section className="feed-page" data-testid={testid}>
      <FeedTitle>{title}</FeedTitle>
      <FeedNav />
      <Gate>{children}</Gate>
    </section>
  );
}

/* ======================= Stories ======================= */

const STORY_BGS = ['amber', 'sage', 'terracotta', 'charcoal'] as const;
const STORY_SECONDS = 6;

/** The row of story rings atop the Feed: yours first (with +), then unseen, then the rest. */
export function StoryRail({ me, grid = false }: { me: CommunityMe; grid?: boolean }) {
  const { data, reload } = useLoad<{ rail: StoryRailItem[] }>('/api/social/stories');
  const [open, setOpen] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const rail = data?.rail ?? [];
  const mine = rail.find((r) => r.me);
  const others = rail.filter((r) => !r.me);
  const self = me.profile;
  if (!self) return null;
  const order = [...(mine ? [mine.author.userId] : []), ...others.map((r) => r.author.userId)];
  return (
    <>
      <div className={grid ? 'story-rail grid' : 'story-rail'} data-testid="story-rail">
        <div className="story-bubble you">
          <button
            type="button"
            className={mine ? 'story-ring seen' : 'story-ring none'}
            aria-label={mine ? 'Watch your story' : 'Add to your story'}
            data-testid="story-you"
            onClick={() => (mine ? setOpen(self.userId) : setComposing(true))}
          >
            <Avatar a={self} size={grid ? 72 : 58} />
          </button>
          <button type="button" className="story-add" aria-label="Add to your story" data-testid="story-add" onClick={() => setComposing(true)}>
            <Icon name="plus" size={14} />
          </button>
          <small>Your story</small>
        </div>
        {others.map((r) => (
          <button key={r.author.userId} type="button" className="story-bubble" onClick={() => setOpen(r.author.userId)} data-testid="story-bubble" data-unseen={r.unseen}>
            <span className={r.unseen ? 'story-ring unseen' : 'story-ring seen'}>
              <Avatar a={r.author} size={grid ? 72 : 58} />
            </span>
            <small>{r.author.displayName}</small>
          </button>
        ))}
        {grid && !others.length && <p className="muted small story-empty">No one else has a story up right now. Stories last 24 hours.</p>}
      </div>
      {open !== null && (
        <StoryViewer
          order={order}
          start={open}
          onClose={() => {
            setOpen(null);
            reload();
          }}
        />
      )}
      {composing && (
        <StoryComposer
          onClose={() => setComposing(false)}
          onPosted={() => {
            setComposing(false);
            reload();
          }}
        />
      )}
    </>
  );
}

/** Fullscreen: one person's stories with progress segments, then on to the next person. */
function StoryViewer({ order, start, onClose }: { order: number[]; start: number; onClose: () => void }) {
  const [at, setAt] = useState(Math.max(0, order.indexOf(start)));
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = before;
    };
  }, [onClose]);
  const userId = order[at];
  if (userId === undefined) return null;
  return (
    <div className="story-viewer" role="dialog" aria-modal="true" aria-label="Stories" data-testid="story-viewer">
      <StoryPerson
        key={userId}
        userId={userId}
        onClose={onClose}
        onNext={() => (at < order.length - 1 ? setAt(at + 1) : onClose())}
        onPrev={() => at > 0 && setAt(at - 1)}
      />
    </div>
  );
}

function StoryPerson({ userId, onClose, onNext, onPrev }: { userId: number; onClose: () => void; onNext: () => void; onPrev: () => void }) {
  const { data, error } = useLoad<{ author: CommunityAuthor; stories: StoryItem[] }>(`/api/social/stories/${userId}`);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [gone, setGone] = useState<Set<number>>(new Set());
  const confirm = useConfirm();
  const stories = (data?.stories ?? []).filter((s) => !gone.has(s.id));
  const s = stories[Math.min(i, stories.length - 1)];
  useEffect(() => {
    if (s) void api(`/api/social/stories/${s.id}/view`, 'POST').catch(() => undefined);
  }, [s?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error)
    return (
      <div className="story-frame">
        <p className="story-missing">{error}</p>
        <button type="button" className="story-close" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
    );
  if (!data || !s) return <div className="story-frame" />;
  const next = (): void => (i < stories.length - 1 ? setI(i + 1) : onNext());
  const prev = (): void => (i > 0 ? setI(i - 1) : onPrev());
  const mine = s.views !== null;
  return (
    <div className={`story-frame bg-${s.bg}`} onPointerDown={() => setPaused(true)} onPointerUp={() => setPaused(false)} onPointerCancel={() => setPaused(false)}>
      <div className="story-bars" aria-hidden="true">
        {stories.map((x, n) => (
          <span key={x.id} className="story-bar">
            <i
              key={n === i ? `${x.id}-on` : x.id}
              className={n < i ? 'done' : n === i ? 'on' : ''}
              style={n === i ? { animationDuration: `${STORY_SECONDS}s`, animationPlayState: paused ? 'paused' : 'running' } : undefined}
              onAnimationEnd={n === i ? next : undefined}
            />
          </span>
        ))}
      </div>
      <header className="story-head">
        <Link to={`/people/${data.author.userId}`} className="story-who" onClick={onClose}>
          <Avatar a={data.author} size={34} />
          <b>{data.author.displayName}</b>
        </Link>
        <small>{ago(s.at)}</small>
        <button type="button" className="story-close" onClick={onClose} aria-label="Close" data-testid="story-close">
          <Icon name="close" />
        </button>
      </header>
      <div className="story-body" data-testid="story-body" data-story={s.id}>
        {s.imageUrl && <img src={s.imageUrl} alt="" className="story-img" />}
        {s.text && <p className={s.imageUrl ? 'story-caption' : 'story-text'}>{s.text}</p>}
        {s.status !== 'visible' && <span className="pill sun story-pending">Under review — only you can see it</span>}
      </div>
      <button type="button" className="story-tap prev" aria-label="Previous" onClick={prev} />
      <button type="button" className="story-tap next" aria-label="Next" onClick={next} data-testid="story-next" />
      <footer className="story-foot">
        {mine ? (
          <>
            <span data-testid="story-views">Seen by {count(s.views ?? 0, 'person', 'people')}</span>
            <button
              type="button"
              className="link light"
              onClick={() => {
                setPaused(true);
                void confirm({ title: 'Delete this story?', body: 'It disappears for everyone right away.', confirmLabel: 'Delete', danger: true }).then((y) => {
                  setPaused(false);
                  if (!y) return;
                  void api(`/api/social/stories/${s.id}`, 'DELETE').then(() => {
                    if (stories.length === 1) onClose();
                    else setGone(new Set([...gone, s.id]));
                  });
                });
              }}
            >
              Delete
            </button>
          </>
        ) : (
          <Link to={`/messages/${data.author.userId}`} className="story-reply" onClick={onClose}>
            Send {data.author.displayName} a message
          </Link>
        )}
      </footer>
    </div>
  );
}

function StoryComposer({ onClose, onPosted }: { onClose: () => void; onPosted: () => void }) {
  const [text, setText] = useState('');
  const [bg, setBg] = useState<(typeof STORY_BGS)[number]>('amber');
  const [photo, setPhoto] = useState<{ id: number; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [review, setReview] = useState<ReviewNote | null>(null);
  return (
    <div className="sheet-back" role="dialog" aria-modal="true" aria-label="Add to your story" data-testid="story-composer">
      <form
        className="sheet"
        onSubmit={(e) => {
          e.preventDefault();
          setMsg(null);
          setBlocked(null);
          setBusy(true);
          void api<{ review: ReviewNote }>('/api/social/stories', 'POST', { text: text.trim() || undefined, imageId: photo?.id, bg })
            .then((r) => (r.review.underReview ? setReview(r.review) : onPosted()))
            .catch((e2: unknown) => (blockedOf(e2) ? setBlocked(blockedOf(e2)) : setMsg(errText(e2, 'Could not post'))))
            .finally(() => setBusy(false));
        }}
      >
        <header className="sheet-head">
          <b>Your story</b>
          <button type="button" className="link" onClick={onClose} aria-label="Close">
            <Icon name="close" size={22} />
          </button>
        </header>
        {review ? (
          <>
            <ReviewBanner note={review} />
            <button type="button" className="btn" onClick={onPosted}>
              OK
            </button>
          </>
        ) : (
          <>
            <div className={`story-preview bg-${bg}`}>
              {photo && <img src={photo.url} alt="" />}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={200}
                rows={photo ? 2 : 4}
                placeholder={photo ? 'Add a caption (optional)' : 'Say something — a win, a wobble, a tip'}
                aria-label="Story text"
                data-testid="story-text"
              />
            </div>
            <div className="row story-tools">
              <span className="story-swatches" role="group" aria-label="Background">
                {STORY_BGS.map((b) => (
                  <button key={b} type="button" className={`swatch bg-${b}${bg === b ? ' on' : ''}`} aria-label={b} aria-pressed={bg === b} onClick={() => setBg(b)} />
                ))}
              </span>
              <label className="btn small ghost">
                {busy && !photo ? 'Adding…' : photo ? 'Change photo' : 'Add a photo'}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  data-testid="story-photo"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    setBusy(true);
                    void uploadPhoto(file)
                      .then((p) => setPhoto({ id: p.id, url: p.url }))
                      .catch((e2: unknown) => setMsg(errText(e2, 'Could not add the photo')))
                      .finally(() => setBusy(false));
                  }}
                />
              </label>
            </div>
            <small className="muted">Gone after 24 hours. No kids’ faces, names or schools — checked before it appears.</small>
            <BlockedNote b={blocked} />
            {msg && (
              <p className="error" role="alert">
                {msg}
              </p>
            )}
            <button className="btn" disabled={busy || (!text.trim() && !photo)} data-testid="story-post">
              Share to your story
            </button>
          </>
        )}
      </form>
    </div>
  );
}

export function StoriesPage() {
  return (
    <FeedSection title="Stories" testid="stories">
      {(me) => (
        <>
          <p className="muted small">Little moments from people you follow and the community. Each one disappears after 24 hours.</p>
          <StoryRail me={me} grid />
        </>
      )}
    </FeedSection>
  );
}

/* ======================= Clips ======================= */

const MAX_CLIP_BYTES = 30 * 1024 * 1024;
const MAX_CLIP_SECONDS = 90;

export function ClipsPage() {
  return <FeedSection title="Clips" testid="clips">{(me) => <ClipsBody me={me} />}</FeedSection>;
}

function ClipsBody({ me }: { me: CommunityMe }) {
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag');
  const user = params.get('user');
  const focus = params.get('c');
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [sponsored, setSponsored] = useState<SponsoredItem | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewNote | null>(null);
  const filter = `${tag ? `&tag=${encodeURIComponent(tag)}` : ''}${user ? `&user=${encodeURIComponent(user)}` : ''}`;
  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all([
      api<{ clips: ClipItem[]; next: number | null; sponsored?: SponsoredItem | null }>(`/api/social/clips?${filter.slice(1)}`),
      focus ? api<{ clip: ClipItem }>(`/api/social/clips/${encodeURIComponent(focus)}`).catch(() => null) : Promise.resolve(null),
    ])
      .then(([page, one]) => {
        if (!live) return;
        const list = one ? [one.clip, ...page.clips.filter((c) => c.id !== one.clip.id)] : page.clips;
        setClips(list);
        setSponsored(page.sponsored ?? null);
        setNext(page.next);
        setErr(null);
      })
      .catch((e: unknown) => live && setErr(errText(e, 'Could not load clips')))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [filter, focus]);
  const more = (): void => {
    if (next === null || loading) return;
    setLoading(true);
    void api<{ clips: ClipItem[]; next: number | null }>(`/api/social/clips?before=${next}${filter}`)
      .then((page) => {
        setClips((c) => [...c, ...page.clips.filter((x) => !c.some((y) => y.id === x.id))]);
        setNext(page.next);
      })
      .finally(() => setLoading(false));
  };
  const swap = (c: ClipItem): void => setClips((list) => list.map((x) => (x.id === c.id ? c : x)));
  return (
    <>
      <div className="row clip-bar">
        {(tag || user) && (
          <span className="pill">
            {tag ? `#${tag}` : 'One person’s clips'}{' '}
            <button type="button" className="link small" onClick={() => setParams({})}>
              × all clips
            </button>
          </span>
        )}
        <span className="grow" />
        {!me.mutedUntil && (
          <button type="button" className="btn small" onClick={() => setUploading(true)} data-testid="clip-new">
            <Icon name="plus" size={16} /> New clip
          </button>
        )}
      </div>
      <ReviewBanner note={review} />
      {msg && (
        <p className="desk-note" role="status">
          {msg}
        </p>
      )}
      {err && <p className="error">{err}</p>}
      <div className="clip-feed" data-testid="clip-feed">
        {clips.map((c, i) => (
          <Fragment key={c.id}>
            <ClipCard c={c} onChange={swap} onGone={(id) => setClips((l) => l.filter((x) => x.id !== id))} onMsg={setMsg} onTag={(t) => setParams({ tag: t })} />
            {i === 0 && sponsored?.clip && <ClipCard c={sponsored.clip} sponsor={sponsored} onChange={(x) => setSponsored({ ...sponsored, clip: x })} onGone={() => setSponsored(null)} onMsg={setMsg} onTag={(t) => setParams({ tag: t })} />}
          </Fragment>
        ))}
        {!loading && !clips.length && !err && (
          <div className="clip-empty">
            <b>No clips yet</b>
            <p className="muted small">Short videos, up to 90 seconds — a routine that works, a win, a tip.</p>
          </div>
        )}
        {next !== null && (
          <button type="button" className="btn ghost small clip-more" onClick={more} disabled={loading}>
            {loading ? 'Loading…' : 'More clips'}
          </button>
        )}
      </div>
      {uploading && (
        <ClipUpload
          onClose={() => setUploading(false)}
          onPosted={(c, r) => {
            setUploading(false);
            setReview(r.underReview ? r : null);
            setClips((l) => [c, ...l]);
          }}
        />
      )}
    </>
  );
}

function ClipCard({ c, sponsor, onChange, onGone, onMsg, onTag }: { c: ClipItem; sponsor?: SponsoredItem; onChange: (c: ClipItem) => void; onGone: (id: number) => void; onMsg: (m: string) => void; onTag: (t: string) => void }) {
  const navigate = useNavigate();
  const ref = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLElement>(null);
  const viewed = useRef(false);
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [comments, setComments] = useState(false);
  const confirm = useConfirm();
  // Plays while it's mostly on screen; counts one view.
  useEffect(() => {
    const el = box.current;
    const v = ref.current;
    if (!el || !v || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          void v.play().catch((e: unknown) => e instanceof DOMException && e.name === 'NotAllowedError' && setPaused(true));
          if (!viewed.current) {
            viewed.current = true;
            void api(`/api/social/clips/${c.id}/view`, 'POST').catch(() => undefined);
          }
        } else v.pause();
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [c.id]);
  const share = async (): Promise<void> => {
    const url = `${window.location.origin}/clips?c=${c.id}`;
    try {
      if (navigator.share) await navigator.share({ title: `${c.author.displayName} on MyDay`, url });
      else {
        await navigator.clipboard.writeText(url);
        onMsg('Link copied — it opens for MyDay members.');
      }
    } catch {
      return;
    }
    void api(`/api/social/clips/${c.id}/share`, 'POST').then(() => onChange({ ...c, shares: c.shares + 1 }));
  };
  return (
    <article className={sponsor ? 'clip sponsored' : 'clip'} ref={box} data-testid={sponsor ? 'sponsored-clip' : 'clip'} data-clip={c.id}>
      <video
        ref={ref}
        src={c.videoUrl}
        poster={c.posterUrl ?? undefined}
        muted={muted}
        loop
        playsInline
        preload="metadata"
        className="clip-video"
        onPlaying={() => setPaused(false)}
        onClick={() => {
          const v = ref.current;
          if (!v) return;
          if (v.paused) {
            void v.play();
            setPaused(false);
          } else {
            v.pause();
            setPaused(true);
          }
        }}
      />
      {paused && <span className="clip-paused" aria-hidden="true">▶</span>}
      <button type="button" className="clip-sound" aria-label={muted ? 'Sound on' : 'Sound off'} onClick={() => setMuted(!muted)}>
        <Icon name={muted ? 'muted' : 'sound'} size={20} />
      </button>
      {c.status !== 'visible' && <span className="pill sun clip-pending">Under review — only you can see it</span>}
      {sponsor && (
        <span className="sponsored-label clip-sponsored" data-testid="sponsored-label">
          Sponsored
        </span>
      )}
      <div className="clip-rail">
        <Link to={`/people/${c.author.userId}`} className="clip-author" aria-label={`${c.author.displayName}’s profile`}>
          <Avatar a={c.author} size={42} />
        </Link>
        <button
          type="button"
          className={c.likedByMe ? 'clip-act on' : 'clip-act'}
          aria-pressed={c.likedByMe}
          aria-label="Like"
          data-testid="clip-like"
          onClick={() => void api<{ clip: ClipItem }>(`/api/social/clips/${c.id}/like`, 'POST').then((r) => onChange(r.clip))}
        >
          <Icon name="heart" filled={c.likedByMe} />
          <small data-testid="clip-likes">{c.likes}</small>
        </button>
        <button type="button" className="clip-act" aria-label="Comments" data-testid="clip-comments" onClick={() => setComments(true)}>
          <Icon name="comment" />
          <small>{c.comments}</small>
        </button>
        <button type="button" className="clip-act" aria-label="Share" onClick={() => void share()}>
          <Icon name="share" />
          <small>{c.shares}</small>
        </button>
        <SlipMenu>
          {c.mine ? (
            <button
              className="link danger small"
              onClick={() =>
                void confirm({ title: 'Delete this clip?', body: 'It’s removed for everyone.', confirmLabel: 'Delete', danger: true }).then(
                  (y) => void (y && api(`/api/social/clips/${c.id}`, 'DELETE').then(() => onGone(c.id))),
                )
              }
            >
              Delete
            </button>
          ) : (
            <ReportButton path={`/api/social/clips/${c.id}/report`} onDone={onMsg} />
          )}
        </SlipMenu>
      </div>
      <div className="clip-meta">
        <Link to={`/people/${c.author.userId}`} className="clip-name">
          @{c.author.displayName}
        </Link>
        {c.caption && <p className="clip-caption">{c.caption.replace(/#[\p{L}\p{N}_]{2,30}/gu, '').trim()}</p>}
        {c.hashtags.length > 0 && (
          <p className="clip-tags">
            {c.hashtags.map((t) => (
              <button key={t} type="button" className="link" onClick={() => onTag(t)}>
                #{t}
              </button>
            ))}
          </p>
        )}
        <small className="clip-views">{count(c.views, 'view')}</small>
        {sponsor && (
          <button
            type="button"
            className="btn small clip-cta"
            data-testid="sponsored-cta"
            onClick={() => void api(`/api/ads/${sponsor.campaignId}/click`, 'POST').catch(() => undefined).then(() => navigate(sponsor.href))}
          >
            {sponsor.cta}
          </button>
        )}
      </div>
      {comments && <ClipComments clip={c} onClose={() => setComments(false)} onCount={(n) => onChange({ ...c, comments: n })} />}
    </article>
  );
}

function ClipComments({ clip, onClose, onCount }: { clip: ClipItem; onClose: () => void; onCount: (n: number) => void }) {
  const { data, reload } = useLoad<{ comments: ClipComment[] }>(`/api/social/clips/${clip.id}/comments`);
  const [body, setBody] = useState('');
  const [review, setReview] = useState<ReviewNote | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (data) onCount(data.comments.filter((x) => x.status === 'visible').length);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="sheet-back" role="dialog" aria-modal="true" aria-label="Comments" data-testid="clip-comment-sheet" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <header className="sheet-head">
          <b>{count(data?.comments.length ?? clip.comments, 'comment')}</b>
          <button type="button" className="link" onClick={onClose} aria-label="Close">
            <Icon name="close" size={22} />
          </button>
        </header>
        <div className="sheet-list">
          {data?.comments.map((x) => (
            <div key={x.id} className="clip-comment" data-testid="clip-comment">
              <Avatar a={x.author} size={30} />
              <div>
                <b>{x.author.displayName}</b> <small className="muted">{ago(x.at)}</small>
                {x.status !== 'visible' && <span className="pill sun">under review</span>}
                <p>{x.body}</p>
              </div>
            </div>
          ))}
          {data && !data.comments.length && <p className="muted small">Be the first to say something kind.</p>}
        </div>
        <ReviewBanner note={review} />
        <BlockedNote b={blocked} />
        {msg && <p className="error">{msg}</p>}
        <form
          className="row sheet-compose"
          onSubmit={(e) => {
            e.preventDefault();
            setBlocked(null);
            setMsg(null);
            void api<{ review: ReviewNote }>(`/api/social/clips/${clip.id}/comments`, 'POST', { body })
              .then((r) => {
                setBody('');
                setReview(r.review.underReview ? r.review : null);
                reload();
              })
              .catch((e2: unknown) => (blockedOf(e2) ? setBlocked(blockedOf(e2)) : setMsg(errText(e2, 'Could not comment'))));
          }}
        >
          <input className="grow" value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} placeholder="Add a comment" aria-label="Add a comment" data-testid="clip-comment-input" required />
          <button className="btn small">Post</button>
        </form>
      </div>
    </div>
  );
}

/** A still from the video as a JPEG (the poster, and the frames the screen looks at). */
async function frameAt(v: HTMLVideoElement, t: number): Promise<Blob | null> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      v.removeEventListener('seeked', done);
      resolve();
    };
    v.addEventListener('seeked', done);
    v.currentTime = t;
    setTimeout(done, 4000);
  });
  const w = Math.min(720, v.videoWidth || 720);
  const h = Math.round(w * ((v.videoHeight || 1280) / (v.videoWidth || 720)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(v, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82));
}

/** Read the video in the browser: its length, plus a poster and two sample frames. */
async function inspect(file: File): Promise<{ duration: number | null; frames: Blob[] }> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error('That video won’t open here — try an MP4 or MOV.'));
      setTimeout(() => resolve(), 8000);
    });
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
    const at = d ? [Math.min(0.5, d / 4), d / 2, (d * 5) / 6] : [0.1];
    const frames: Blob[] = [];
    for (const t of at) {
      const b = await frameAt(v, t).catch(() => null);
      if (b && b.size > 1000) frames.push(b);
    }
    return { duration: d, frames };
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

function ClipUpload({ onClose, onPosted }: { onClose: () => void; onPosted: (c: ClipItem, r: ReviewNote) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [step, setStep] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  const pick = (f: File | undefined): void => {
    setMsg(null);
    if (!f) return;
    if (f.size > MAX_CLIP_BYTES) {
      setMsg('That video is over 30 MB — trim it a little and try again.');
      return;
    }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };
  const post = async (): Promise<void> => {
    if (!file) return;
    setMsg(null);
    setBlocked(null);
    try {
      setStep('Reading the video…');
      const info = await inspect(file);
      if (info.duration !== null && info.duration > MAX_CLIP_SECONDS + 0.5) throw new Error(`Clips are up to ${MAX_CLIP_SECONDS} seconds — this one is ${Math.round(info.duration)}.`);
      setStep('Checking the frames…');
      const imgs = [];
      for (const f of info.frames) imgs.push(await uploadImage(f));
      setStep('Uploading…');
      const res = await fetch('/api/social/videos', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type || 'video/mp4', 'X-MyDay-Upload': '1' },
        body: file,
      });
      const out = (await res.json().catch(() => null)) as { id?: number; error?: string } | null;
      if (!res.ok || !out?.id) throw new ApiFail(res.status, out?.error ?? (res.status === 413 ? 'That video is over 30 MB.' : 'Upload failed'));
      setStep('Posting…');
      const r = await api<{ clip: ClipItem; review: ReviewNote }>('/api/social/clips', 'POST', {
        videoId: out.id,
        posterId: imgs[0]?.id,
        frameIds: imgs.slice(1).map((x) => x.id),
        caption: caption.trim(),
        durationS: info.duration === null ? null : Math.round(info.duration * 10) / 10,
      });
      onPosted(r.clip, r.review);
    } catch (e) {
      if (blockedOf(e)) setBlocked(blockedOf(e));
      else setMsg(errText(e, 'Could not post the clip'));
    } finally {
      setStep(null);
    }
  };
  return (
    <div className="sheet-back" role="dialog" aria-modal="true" aria-label="New clip" data-testid="clip-upload">
      <form
        className="sheet"
        onSubmit={(e) => {
          e.preventDefault();
          void post();
        }}
      >
        <header className="sheet-head">
          <b>New clip</b>
          <button type="button" className="link" onClick={onClose} aria-label="Close" disabled={!!step}>
            <Icon name="close" size={22} />
          </button>
        </header>
        {preview ? (
          <video src={preview} className="clip-upload-preview" controls playsInline muted />
        ) : (
          <div className="row clip-pick">
            <label className="btn">
              Record
              <input type="file" accept="video/*" capture="user" hidden onChange={(e) => pick(e.target.files?.[0])} />
            </label>
            <label className="btn ghost">
              Choose a video
              <input type="file" accept="video/mp4,video/quicktime,video/webm,video/*" hidden data-testid="clip-file" onChange={(e) => pick(e.target.files?.[0])} />
            </label>
          </div>
        )}
        <label>
          Caption
          <textarea value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={300} rows={2} placeholder="What’s this about? Add #hashtags" data-testid="clip-caption" />
        </label>
        <small className="muted">Up to 90 seconds and 30 MB. No kids’ faces, names or schools — every clip is checked before it appears.</small>
        <BlockedNote b={blocked} />
        {msg && (
          <p className="error" role="alert">
            {msg}
          </p>
        )}
        <button className="btn" disabled={!file || !!step} data-testid="clip-post">
          {step ?? 'Post clip'}
        </button>
      </form>
    </div>
  );
}

/* ======================= Messages ======================= */

export function MessagesPage() {
  return <FeedSection title="Messages" testid="messages">{() => <Inbox />}</FeedSection>;
}

function Inbox() {
  const { data, error } = useLoad<{ threads: DmThreadSummary[]; unread: number }>('/api/social/messages');
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="muted small">One-to-one, grown-ups only. Every message is checked before it’s delivered; you can mute, block or report anyone.</p>
      <div className="dm-list" data-testid="dm-list">
        {data.threads.map((t) => (
          <Link key={t.other.userId} to={`/messages/${t.other.userId}`} className={t.unread ? 'dm-row unread' : 'dm-row'} data-testid="dm-row">
            <Avatar a={t.other} size={46} />
            <span className="dm-row-text">
              <b>
                {t.other.displayName}
                {t.muted && <small className="muted"> · muted</small>}
              </b>
              <small className="muted">{t.last ? `${t.last.mine ? 'You: ' : ''}${t.last.body}` : 'No messages yet'}</small>
            </span>
            <span className="dm-row-side">
              {t.last && <small className="muted">{ago(t.last.at)}</small>}
              {t.unread > 0 && <span className="feed-nav-badge">{t.unread}</span>}
            </span>
          </Link>
        ))}
        {!data.threads.length && (
          <div className="clip-empty">
            <b>No messages yet</b>
            <p className="muted small">Open someone’s profile and tap Message to start a conversation.</p>
          </div>
        )}
      </div>
    </>
  );
}

export function MessageThreadPage() {
  const { id } = useParams();
  return (
    <section className="feed-page" data-testid="dm-thread-page">
      <FeedNav />
      <Gate>{() => <Thread id={id ?? ''} />}</Gate>
    </section>
  );
}

function Thread({ id }: { id: string }) {
  const { data, error, setData, reload } = useLoad<DmThread>(`/api/social/messages/${encodeURIComponent(id)}`);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ReviewNote | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [params] = useSearchParams();
  const end = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const navigate = useNavigate();
  const consult = params.has('consult');
  // New messages show up while the conversation is open.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && reload(), 10000);
    return () => clearInterval(t);
  }, [reload]);
  const last = data?.messages.at(-1)?.id;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [last]);
  useEffect(() => {
    if (consult && data && !body) setBody(`Hi ${data.other.displayName} — I’d like to book a consult. When do you have time?`);
  }, [consult, data?.other.userId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const o = data.other;
  return (
    <div className="dm-thread" data-testid="dm-thread">
      <header className="dm-head">
        <button type="button" className="link" onClick={() => navigate('/messages')} aria-label="All messages">
          ←
        </button>
        <Link to={`/people/${o.userId}`} className="dm-head-who">
          <Avatar a={o} size={36} />
          <b>{o.displayName}</b>
        </Link>
        <span className="grow" />
        <SlipMenu>
          <button
            className="link small"
            data-testid="dm-mute"
            onClick={() => void api<DmThread>(`/api/social/messages/${o.userId}/mute`, 'POST', { muted: !data.muted }).then(setData)}
          >
            {data.muted ? 'Unmute' : 'Mute'}
          </button>
          {!data.blocked && (
            <button
              className="link danger small"
              data-testid="dm-block"
              onClick={() =>
                void confirm({ title: `Block ${o.displayName}?`, body: 'Neither of you can message the other, and you won’t see each other’s posts.', confirmLabel: 'Block', danger: true }).then(
                  (y) => void (y && api(`/api/community/people/${o.userId}/block`, 'POST').then(reload)),
                )
              }
            >
              Block
            </button>
          )}
        </SlipMenu>
      </header>
      {data.muted && <p className="small muted dm-note">Muted — you won’t get notified about this conversation.</p>}
      <div className="dm-messages" data-testid="dm-messages">
        {data.messages.map((m) => (
          <div key={m.id} className={m.mine ? 'dm-msg mine' : 'dm-msg'} data-testid="dm-message">
            <p>{m.body}</p>
            <small>
              {ago(m.at)}
              {m.status !== 'visible' && ' · under review — not delivered yet'}
            </small>
            {!m.mine && <ReportButton path={`/api/social/messages/report/${m.id}`} onDone={setMsg} />}
          </div>
        ))}
        {!data.messages.length && !data.blocked && <p className="muted small dm-note">Say hello to {o.displayName}. Be kind — messages are checked before they’re delivered.</p>}
        <div ref={end} />
      </div>
      {msg && (
        <p className="desk-note" role="status">
          {msg}
        </p>
      )}
      {review?.crisis && <CrisisCard />}
      {review?.underReview && !review.crisis && (
        <p className="card note" role="status" data-testid="under-review">
          <b>Under review.</b> A moderator will look before {o.displayName} sees it.
        </p>
      )}
      <BlockedNote b={blocked} />
      {data.blocked ? (
        <p className="card note" data-testid="dm-blocked">
          You can’t message each other.
        </p>
      ) : (
        <form
          className="dm-compose"
          onSubmit={(e) => {
            e.preventDefault();
            if (!body.trim()) return;
            setBusy(true);
            setBlocked(null);
            setMsg(null);
            void api<{ thread: DmThread; review: ReviewNote }>(`/api/social/messages/${o.userId}`, 'POST', { body })
              .then((r) => {
                setData(r.thread);
                setReview(r.review.underReview ? r.review : null);
                setBody('');
              })
              .catch((e2: unknown) => (blockedOf(e2) ? setBlocked(blockedOf(e2)) : setMsg(errText(e2, 'Could not send'))))
              .finally(() => setBusy(false));
          }}
        >
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={1} placeholder={`Message ${o.displayName}`} aria-label="Message" data-testid="dm-input" />
          <button className="btn small" disabled={busy || !body.trim()} data-testid="dm-send">
            Send
          </button>
        </form>
      )}
    </div>
  );
}

/* ======================= Sponsored (the Provider Business Suite's ads) ======================= */

/** A verified provider's paid placement: always labelled "Sponsored". Only ever inside the 18+ Feed. */
export function SponsoredCard({ s }: { s: SponsoredItem }) {
  const navigate = useNavigate();
  const click = (): Promise<unknown> => api(`/api/ads/${s.campaignId}/click`, 'POST').catch(() => undefined);
  const picture = s.imageUrl ?? s.post?.imageUrl ?? s.clip?.posterUrl ?? null;
  const body = s.body ?? s.post?.body ?? s.clip?.caption ?? '';
  return (
    <article className="slip sponsored" data-testid="sponsored" data-campaign={s.campaignId}>
      <header className="slip-head">
        <Link to={`/people/${s.provider.userId}`} className="who-chip">
          <Avatar a={s.provider} size={28} />
          <b>{s.provider.displayName}</b>
        </Link>
        <span className="sponsored-label" data-testid="sponsored-label">
          Sponsored
        </span>
      </header>
      {picture && <img src={picture} alt="" className="feed-photo" />}
      {s.headline && <b className="sponsored-head">{s.headline}</b>}
      {body && <p className="slip-body">{body}</p>}
      {s.external ? (
        <a className="btn small" href={s.href} target="_blank" rel="noopener noreferrer sponsored" onClick={() => void click()} data-testid="sponsored-cta">
          {s.cta} ↗
        </a>
      ) : (
        <button type="button" className="btn small" onClick={() => void click().then(() => navigate(s.href))} data-testid="sponsored-cta">
          {s.cta}
        </button>
      )}
    </article>
  );
}

/* ======================= Booking a consult (a verified provider's open times) ======================= */

export function BookConsult({ provider, onClose }: { provider: CommunityAuthor; onClose: () => void }) {
  const { data, error, reload } = useLoad<{ slots: ConsultSlot[] }>(`/api/providers/${provider.userId}/slots`);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const navigate = useNavigate();
  const open = data?.slots.filter((s) => s.status === 'open') ?? [];
  const mine = data?.slots.filter((s) => s.mine && s.status === 'booked') ?? [];
  const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <div className="sheet-back" role="dialog" aria-modal="true" aria-label="Book a consult" data-testid="book-sheet" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <header className="sheet-head">
          <b>Book a consult with {provider.displayName}</b>
          <button type="button" className="link" onClick={onClose} aria-label="Close">
            <Icon name="close" size={22} />
          </button>
        </header>
        {error && <p className="error">{error}</p>}
        {mine.map((s) => (
          <p key={s.id} className="card note small" data-testid="booked-note">
            ✓ You’re booked: {when(s.startsAt)} ({s.minutes} min). {provider.displayName} will message you about the call.
          </p>
        ))}
        {data && !open.length && (
          <p className="muted small">
            No open times right now.{' '}
            <Link to={`/messages/${provider.userId}?consult=1`} onClick={onClose}>
              Send {provider.displayName} a message
            </Link>{' '}
            instead.
          </p>
        )}
        <div className="sheet-list">
          {open.map((s) => (
            <button
              key={s.id}
              type="button"
              className="book-slot"
              disabled={busy !== null}
              data-testid="book-slot"
              onClick={() => {
                setBusy(s.id);
                setMsg(null);
                void api<{ booked: boolean; url: string | null }>(`/api/consults/${s.id}/book`, 'POST')
                  .then((r) => {
                    if (r.url && !r.url.startsWith('/')) window.location.href = r.url;
                    else {
                      setMsg(`Booked ✓ ${when(s.startsAt)}. ${provider.displayName} will message you about the call.`);
                      reload();
                      if (r.url) navigate(r.url, { replace: true });
                    }
                  })
                  .catch((e: unknown) => {
                    setMsg(errText(e, 'Could not book'));
                    reload();
                  })
                  .finally(() => setBusy(null));
              }}
            >
              <b>{when(s.startsAt)}</b>
              <span>
                {s.minutes} min · {s.priceCents ? `$${(s.priceCents / 100).toFixed(2)}` : 'Free'}
              </span>
            </button>
          ))}
        </div>
        {msg && (
          <p className="small" role="status" data-testid="book-msg">
            {msg}
          </p>
        )}
        <small className="muted">Paid consults go through secure checkout. A consult is general guidance, not emergency care — if you’re in crisis, call or text 988.</small>
      </div>
    </div>
  );
}

/* ======================= The public landing page (/feed, signed out) ======================= */

interface FeedPreview {
  members: number;
  postsThisWeek: number;
  web: Array<{ publisher: string; title: string; url: string; publishedAt: string }>;
  villages: Array<{ name: string; description: string }>;
}

const FEATURES: Array<{ icon: string; name: string; line: string }> = [
  { icon: 'camera', name: 'Stories & Clips', line: 'Little moments that disappear after 24 hours, and short videos of the routine that finally stuck.' },
  { icon: 'family', name: 'Villages & Circles', line: 'Forums for ADHD parents, late diagnosis and partners — and small groups for the people you trust.' },
  { icon: 'shield', name: 'Safe, kind & verified', line: 'Every post, clip and message is checked first. Licensed clinicians are verified before they get a badge.' },
];

export function FeedLanding() {
  const { data } = useLoad<FeedPreview>('/api/public/feed-preview');
  const [age, setAge] = useState<'ok' | 'under' | null>(stored(AGE_KEY) === '1' ? 'ok' : null);
  const [joining, setJoining] = useState(false);
  const signin = useRef<HTMLDivElement>(null);
  const join = (): void => {
    store(NEXT_KEY, '/feed');
    setJoining(true);
    setTimeout(() => signin.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };
  const web = data?.web ?? [];
  return (
    <div className="fl" data-testid="feed-landing">
      <div className="fl-page" aria-hidden={age !== 'ok'}>
        <header className="fl-top">
          <a href="#top" className="fl-brand">
            <FeedHorn tile size={40} />
            <b>The Feed</b>
          </a>
          <nav className="fl-links" aria-label="The Feed">
            <a href="/">Home</a>
            <a href="#top" className="on">
              Feed
            </a>
            <a href="#features">Community</a>
            <a href="#preview">Resources</a>
            <a href="#safe">About</a>
          </nav>
          <span className="grow" />
          <a href="/" className="fl-signin">
            Sign in
          </a>
          <button type="button" className="btn ghost fl-join-top" onClick={join}>
            Join
          </button>
        </header>
        <section className="fl-hero" id="top">
          <FeedHorn tile size={96} className="fl-hero-mark" />
          <span className="fl-pill">18+ adults only</span>
          <h1>The Feed</h1>
          <p>A calm, supportive community for ADHD adults — share, connect, and build routines that actually stick.</p>
          <button type="button" className="btn fl-cta" onClick={join} data-testid="feed-join">
            Join the Feed
          </button>
          <small className="fl-fine">Free for everyone. No subscription. Kids never see the Feed — or its ads.</small>
          <div ref={signin} className="fl-signin-box" hidden={!joining} data-testid="feed-signin">
            <b>Create your free account</b>
            <SignInChoices />
          </div>
        </section>
        <section className="fl-section" id="features">
          <h2 className="fl-eyebrow">Features designed for ADHD adults</h2>
          <div className="fl-features">
            {FEATURES.map((f) => (
              <div key={f.name} className="fl-feature">
                <span className="fl-feature-icon">
                  <NavIcon name={f.icon} size={26} />
                </span>
                <b>{f.name}</b>
                <small>{f.line}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="fl-section" id="preview" aria-label="Live from the Feed" data-testid="feed-preview">
          <h2 className="fl-eyebrow">Live feed preview</h2>
          <div className="fl-live">
            <div className="fl-card fl-stats-card">
              <div className="fl-stats">
                <span>
                  <b>{data ? data.members.toLocaleString() : '—'}</b>
                  <small>members</small>
                </span>
                <span>
                  <b>{data ? data.postsThisWeek.toLocaleString() : '—'}</b>
                  <small>posts this week</small>
                </span>
                <span>
                  <b>{data ? data.villages.length : '—'}</b>
                  <small>villages</small>
                </span>
              </div>
              {data && (
                <div className="fl-villages">
                  {data.villages.map((v) => (
                    <p key={v.name} className="fl-village">
                      <b>{v.name}</b>
                      <small>{v.description}</small>
                    </p>
                  ))}
                </div>
              )}
            </div>
            {web.slice(0, 2).map((w) => (
              <a key={w.url} href={w.url} target="_blank" rel="noopener noreferrer" className="fl-card fl-web">
                <span className="fl-web-pub">
                  <span className="fl-web-badge">{w.publisher.slice(0, 1)}</span>
                  <small>
                    {w.publisher} · {new Date(w.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </small>
                </span>
                <b>{w.title}</b>
                <small className="fl-web-more">Around the web ↗</small>
              </a>
            ))}
          </div>
          <p className="fl-fine fl-center">Members’ posts are only visible inside MyDay, to signed-in adults.</p>
        </section>
        <section className="fl-safe" id="safe">
          <h2>Kind by design</h2>
          <p>Every post, photo, clip and message is checked before it appears. Real people moderate, crisis posts go straight to the top, and anyone who needs help right away sees the 988 Suicide &amp; Crisis Lifeline.</p>
          <button type="button" className="btn fl-cta" onClick={join}>
            Join the Feed
          </button>
        </section>
        <footer className="fl-foot">
          <a href="#safe">Community guidelines</a> • <a href="/privacy">Privacy policy</a> • <a href="/terms">Terms</a> • <span>© {new Date().getFullYear()} MyDay</span>
        </footer>
      </div>
      {age !== 'ok' && (
        <div className="fl-gate" role="dialog" aria-modal="true" aria-labelledby="fl-gate-title" data-testid="age-gate">
          <div className="fl-gate-card">
            <FeedHorn tile size={64} className="fl-gate-mark" />
            {age === 'under' ? (
              <>
                <h2 id="fl-gate-title">The Feed is for adults</h2>
                <p>You need to be 18 or older to visit the Feed. MyDay has plenty for kids and teens inside a family account.</p>
                <a className="btn" href="/">
                  Back to MyDay
                </a>
              </>
            ) : (
              <>
                <h2 id="fl-gate-title">Are you 18 or older?</h2>
                <p>The Feed is a community for adults. You’ll confirm your date of birth when you join.</p>
                <button
                  type="button"
                  className="btn"
                  data-testid="age-yes"
                  onClick={() => {
                    store(AGE_KEY, '1');
                    setAge('ok');
                  }}
                >
                  I’m 18 or older
                </button>
                <button type="button" className="btn ghost" data-testid="age-no" onClick={() => setAge('under')}>
                  I’m under 18
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
