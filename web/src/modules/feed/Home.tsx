/**
 * The Feed's home (stories, the composer pill, the bottomless posts with a "New posts" pill), Explore,
 * the full-page composer (photo, poll, feeling, place, who sees it, who can comment) and a post's own page.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { FEED_FEELINGS, type FeedSort, type CommentsFrom, type FeedPage, type FeedPost, type FeedFeeling, type FriendsData, type PostAudience, type PostComment, type ReviewNote, type WebItem } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { FEED_APP } from '../../apps';
import { blockedOf, BlockedNote, EmptySheet, Gate, ReportButton, ReviewBanner, RichText, uploadPhoto, type Blocked } from '../community/Community';
import { SponsoredCard, StoryRail } from '../social/Social';
import { CatchupCard, EndlessPosts, MemoriesCard, StreakChip } from '../social/Endless';
import { InstallFeed } from '../social/shell';
import { Avatar, Filters, FriendButton, HomeBar, Icon, IconLink, Name, Sheet, TopBar, errText, short, since, useMe } from './kit';
import { PostCard } from './PostCard';

/* ======================= Home ======================= */

export function FeedHome() {
  const inbox = useLoad<{ unread: number }>('/api/social/messages');
  return (
    <section data-testid="feed" className="sc-page feed-page">
      <HomeBar
        right={
          <>
            <IconLink to="/feed/explore" icon="search" label="Search the Feed" testid="feed-search" />
            <IconLink to="/messages" icon="message" label="Messages" testid="feed-messages" badge={inbox.data?.unread ?? 0} />
          </>
        }
      />
      {FEED_APP && <InstallFeed />}
      <Gate>{() => <HomeBody />}</Gate>
    </section>
  );
}

function HomeBody() {
  const me = useMe();
  const location = useLocation();
  const [review, setReview] = useState<ReviewNote | null>((location.state as { review?: ReviewNote } | null)?.review ?? null);
  const [msg, setMsg] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // "For you" (ranked, friends first) or "Latest" (newest first): the server remembers the choice.
  const [sort, setSort] = useState<FeedSort | null>(null);
  const [asked, setAsked] = useState<FeedSort | undefined>(undefined);
  const top = useRef<number | null>(null);
  const [fresh, setFresh] = useState(false);
  // "New posts": checks quietly; a tap brings them in at the top.
  useEffect(() => {
    let live = true;
    const peek = (): void => {
      void api<FeedPage>('/api/feed?tab=everyone').then((page) => {
        if (!live) return;
        const newest = page.posts.find((p) => !p.mine)?.id ?? null;
        if (newest === null) return;
        if (top.current === null) top.current = newest;
        else if (newest > top.current) setFresh(true);
      }, () => undefined);
    };
    peek();
    const t = setInterval(() => document.visibilityState === 'visible' && peek(), 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [round]);
  useEffect(() => {
    if (location.state) window.history.replaceState({}, '');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me?.profile) return null;
  const card = (p: FeedPost) => <PostCard p={p} onChange={() => undefined} onMsg={setMsg} onGone={() => undefined} />;
  return (
    <>
      <StoryRail me={me} />
      <div className="sc-card sc-composer-pill" data-testid="composer-pill">
        <Link to={`/people/${me.profile.userId}`} className="sc-composer-me" aria-hidden="true" tabIndex={-1}>
          <Avatar a={me.profile} size={52} />
        </Link>
        <div className="sc-composer-field">
          <Link to="/feed/create" className="sc-composer-prompt" data-testid="composer-open">
            What’s on your mind?
          </Link>
          <Link to="/feed/create?add=photo" className="sc-icon-btn sm" aria-label="Add a photo" data-testid="quick-photo">
            <Icon name="image" />
          </Link>
          <Link to="/feed/create?add=poll" className="sc-icon-btn sm" aria-label="Start a poll" data-testid="quick-poll">
            <Icon name="poll" />
          </Link>
          <Link to="/feed/create?add=feeling" className="sc-icon-btn sm" aria-label="Add a feeling" data-testid="quick-feeling">
            <Icon name="smile" />
          </Link>
        </div>
      </div>
      {fresh && (
        <button
          type="button"
          className="sc-newposts"
          data-testid="new-posts"
          onClick={() => {
            setFresh(false);
            top.current = null;
            setRound((n) => n + 1);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          New posts
        </button>
      )}
      <ReviewBanner note={review} />
      {review && (
        <button type="button" className="sc-link small" onClick={() => setReview(null)}>
          OK
        </button>
      )}
      {msg && (
        <p className="sc-toast" role="status" onClick={() => setMsg(null)}>
          {msg}
        </p>
      )}
      <CatchupCard renderPost={card} />
      <MemoriesCard renderPost={card} />
      <StreakChip />
      <Filters
        items={[
          { key: 'ranked', label: 'For you' },
          { key: 'latest', label: 'Latest' },
        ]}
        on={sort ?? 'ranked'}
        onPick={(k) => {
          if (k === sort) return;
          setSort(k);
          setAsked(k);
          setRound((n) => n + 1);
        }}
        testid={(k) => `feed-sort-${k}`}
      />
      <EndlessPosts
        key={round}
        sort={asked}
        onSort={setSort}
        renderPost={(p, update, gone) => <PostCard p={p} onChange={update} onMsg={setMsg} onGone={gone} />}
        renderSponsored={(sp) => <SponsoredCard s={sp} />}
      />
    </>
  );
}

/* ======================= Explore ======================= */

export function ExplorePage() {
  return (
    <section data-testid="explore" className="sc-page feed-page">
      <TopBar title="Explore" />
      <Gate>{() => <Explore />}</Gate>
    </section>
  );
}

function Explore() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const topics = useLoad<{ topics: Array<{ tag: string; count: number }> }>('/api/feed/topics');
  const friends = useLoad<FriendsData>('/api/friends');
  const trending = useLoad<{ posts: FeedPost[] }>('/api/feed/trending');
  const [msg, setMsg] = useState<string | null>(null);
  const [web, setWeb] = useState(false);
  const setPost = (p: FeedPost): void => {
    if (trending.data) trending.setData({ posts: trending.data.posts.map((x) => (x.id === p.id ? p : x)) });
  };
  return (
    <>
      <form
        className="sc-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <Icon name="search" size={22} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, topics, groups…" aria-label="Search the Feed" data-testid="explore-input" />
      </form>
      {!!topics.data?.topics.length && (
        <div className="sc-chips" data-testid="trending-topics">
          {topics.data.topics.slice(0, 8).map((t) => (
            <Link key={t.tag} to={`/search?q=${encodeURIComponent(`#${t.tag}`)}`} className="sc-chip-outline" data-testid="search-topic">
              {t.tag.replace(/_/g, ' ')}
            </Link>
          ))}
        </div>
      )}
      <nav className="sc-explore-links" aria-label="More of the Feed">
        <Link to="/clips" className="sc-explore-link" data-testid="explore-clips">
          <Icon name="clip" /> Clips
        </Link>
        <Link to="/village" className="sc-explore-link" data-testid="explore-villages">
          <Icon name="village" /> Villages
        </Link>
        <button type="button" className={web ? 'sc-explore-link on' : 'sc-explore-link'} onClick={() => setWeb(!web)} data-testid="feed-tab-web">
          <Icon name="globe" /> Around the web
        </button>
      </nav>
      {web && <WebItems />}
      {!!friends.data?.suggestions.length && (
        <>
          <h2 className="sc-h2">People you may know</h2>
          <div className="sc-pymk" data-testid="pymk">
            {friends.data.suggestions.map((p) => (
              <PymkCard key={p.userId} p={p} />
            ))}
          </div>
        </>
      )}
      {msg && (
        <p className="sc-toast" role="status" onClick={() => setMsg(null)}>
          {msg}
        </p>
      )}
      <h2 className="sc-h2">Trending posts</h2>
      <div className="sc-list" data-testid="trending-posts">
        {trending.data?.posts.map((p) => (
          <PostCard key={p.id} p={p} onChange={setPost} onMsg={setMsg} onGone={() => trending.reload()} />
        ))}
        {trending.data && !trending.data.posts.length && <p className="sc-meta">Nothing trending this week yet.</p>}
      </div>
    </>
  );
}

function PymkCard({ p }: { p: FriendsData['suggestions'][number] }) {
  const [rel, setRel] = useState<'none' | 'requested'>('none');
  return (
    <div className="sc-card sc-pymk-card" data-testid="pymk-card">
      <Link to={`/people/${p.userId}`} className="sc-pymk-face">
        <Avatar a={p} size={72} />
        <Name a={p} link={false} />
      </Link>
      <small className="sc-meta">{p.mutualFriends ? `${p.mutualFriends} mutual ${p.mutualFriends === 1 ? 'friend' : 'friends'}` : `${short(p.friends)} ${p.friends === 1 ? 'friend' : 'friends'}`}</small>
      <FriendButton userId={p.userId} rel={rel} onChange={(r) => setRel(r === 'requested' ? 'requested' : 'none')} compact testid="pymk-add" />
    </div>
  );
}

function WebItems() {
  const { data, error } = useLoad<{ items: WebItem[] }>('/api/feed/web');
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="sc-meta">Gathering articles…</p>;
  if (!data.items.length) return <EmptySheet title="No articles yet">Articles from ADHD publishers land here a few times a day.</EmptySheet>;
  return (
    <div className="sc-list" data-testid="web-items">
      <p className="sc-meta">From trusted ADHD publishers. Each one opens on the publisher’s own site.</p>
      {data.items.map((w) => (
        <a key={w.id} href={w.url} target="_blank" rel="noopener noreferrer" className="sc-card sc-web" data-testid="web-item">
          <small className="sc-meta">{w.publisher}</small>
          <b>{w.title}</b>
          {w.summary && <span>{w.summary}</span>}
          <small className="sc-meta">
            {since(w.publishedAt)} · Read on {w.publisher} ↗
          </small>
        </a>
      ))}
    </div>
  );
}

/* ======================= Create ======================= */

export function CreatePage() {
  return (
    <section data-testid="create" className="sc-page feed-page">
      <Gate>{() => <Create />}</Gate>
    </section>
  );
}

function Create() {
  const me = useMe();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const add = params.get('add');
  const [body, setBody] = useState('');
  const [photo, setPhoto] = useState<{ id: number; url: string } | null>(null);
  const [poll, setPoll] = useState<string[] | null>(add === 'poll' ? ['', ''] : null);
  const [feeling, setFeeling] = useState<FeedFeeling | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [audience, setAudience] = useState<PostAudience | null>(null);
  const [commentsFrom, setCommentsFrom] = useState<CommentsFrom>('anyone');
  const [picking, setPicking] = useState(add === 'feeling');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const placeBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (add === 'photo') file.current?.click();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const p = me?.profile;
  if (!p) return null;
  const aud = audience ?? p.defaultAudience ?? 'public';
  const pollOk = !poll || poll.filter((o) => o.trim()).length >= 2;
  const ready = (body.trim() || photo || poll) && pollOk && !busy;
  const pickPhoto = (f: File): void => {
    setBusy(true);
    void uploadPhoto(f)
      .then((ph) => setPhoto({ id: ph.id, url: ph.url }))
      .catch((e) => setMsg(errText(e, 'Could not add the photo')))
      .finally(() => setBusy(false));
  };
  return (
    <form
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setMsg(null);
        setBlocked(null);
        setBusy(true);
        void api<{ review: ReviewNote }>('/api/feed/posts', 'POST', {
          body,
          imageId: photo?.id ?? null,
          poll: poll ? { options: poll.map((o) => o.trim()).filter(Boolean) } : undefined,
          feeling: feeling ?? undefined,
          place: place?.trim() || undefined,
          audience: aud,
          commentsFrom,
        })
          .then((r) => navigate('/feed', { state: r.review.underReview || r.review.crisis ? { review: r.review } : null }))
          .catch((e2: unknown) => (blockedOf(e2) ? setBlocked(blockedOf(e2)) : setMsg(errText(e2, 'Could not post'))))
          .finally(() => setBusy(false));
      }}
    >
      <TopBar
        left={
          <button type="button" className="sc-text-btn" onClick={() => navigate(-1)} data-testid="create-cancel">
            Cancel
          </button>
        }
        title="New post"
        right={
          <button className="sc-btn small" disabled={!ready} data-testid="post-submit">
            Post
          </button>
        }
      />
      <div className="sc-card sc-create">
        <div className="sc-create-head">
          <Avatar a={p} size={60} />
          <div className="sc-create-main">
            <b>{p.displayName}</b>
            {(feeling || place !== null) && (
              <p className="sc-meta">
                {feeling && (
                  <button type="button" className="sc-tag" onClick={() => setFeeling(null)} aria-label="Remove feeling">
                    feeling {feeling} <Icon name="x" size={12} />
                  </button>
                )}
                {place !== null && (
                  <span className="sc-tag">
                    <Icon name="pin" size={13} />
                    <input ref={placeBox} value={place} onChange={(e) => setPlace(e.target.value)} maxLength={60} placeholder="City" aria-label="City" data-testid="create-place" />
                    <button type="button" onClick={() => setPlace(null)} aria-label="Remove location">
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                )}
              </p>
            )}
            <textarea
              aria-label="Share something"
              placeholder={`Share what’s on your mind, ${p.displayName}…`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={2000}
              rows={4}
              autoFocus={!add}
              data-testid="create-body"
            />
            {photo && (
              <span className="sc-thumb">
                <img src={photo.url} alt="Your photo" />
                <button type="button" onClick={() => setPhoto(null)} aria-label="Remove photo">
                  <Icon name="x" size={18} />
                </button>
              </span>
            )}
            {poll && (
              <div className="sc-poll-edit" data-testid="poll-edit">
                {poll.map((o, i) => (
                  <input
                    key={i}
                    value={o}
                    maxLength={80}
                    placeholder={`Option ${i + 1}`}
                    aria-label={`Option ${i + 1}`}
                    onChange={(e) => setPoll(poll.map((x, j) => (j === i ? e.target.value : x)))}
                    data-testid="poll-input"
                  />
                ))}
                <span className="sc-row">
                  {poll.length < 4 && (
                    <button type="button" className="sc-link small" onClick={() => setPoll([...poll, ''])}>
                      + Add an option
                    </button>
                  )}
                  <button type="button" className="sc-link small muted" onClick={() => setPoll(null)}>
                    Remove poll
                  </button>
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="sc-create-pills">
          <label className="sc-select">
            <select value={aud} onChange={(e) => setAudience(e.target.value as PostAudience)} aria-label="Who can see this" data-testid="create-audience">
              <option value="public">Public</option>
              <option value="friends">Friends</option>
            </select>
            <Icon name="down" size={16} />
          </label>
          <label className="sc-select">
            <select value={commentsFrom} onChange={(e) => setCommentsFrom(e.target.value as CommentsFrom)} aria-label="Who can comment" data-testid="create-comments">
              <option value="anyone">Anyone can comment</option>
              <option value="friends">Friends can comment</option>
              <option value="nobody">Comments off</option>
            </select>
            <Icon name="down" size={16} />
          </label>
        </div>
        <div className="sc-create-tools">
          <label className="sc-tool">
            <Icon name="image" size={34} />
            <span>{busy && !photo ? 'Adding…' : 'Photo'}</span>
            <input
              ref={file}
              type="file"
              accept="image/*"
              hidden
              data-testid="create-photo"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) pickPhoto(f);
              }}
            />
          </label>
          <button type="button" className="sc-tool" onClick={() => setPoll(poll ?? ['', ''])} data-testid="create-poll">
            <Icon name="poll" size={34} />
            <span>Poll</span>
          </button>
          <button type="button" className="sc-tool" onClick={() => setPicking(true)} data-testid="create-feeling">
            <Icon name="smile" size={34} />
            <span>Feeling</span>
          </button>
          <button
            type="button"
            className="sc-tool"
            onClick={() => {
              setPlace(place ?? '');
              setTimeout(() => placeBox.current?.focus(), 0);
            }}
            data-testid="create-location"
          >
            <Icon name="pin" size={34} />
            <span>Location</span>
          </button>
        </div>
      </div>
      <BlockedNote b={blocked} />
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
      <p className="sc-meta sc-center">Posts are screened for kindness before they appear. No kids’ faces, names or schools. Location is a city — never an address.</p>
      {picking && (
        <Sheet title="How are you feeling?" onClose={() => setPicking(false)} testid="feeling-sheet">
          <div className="sc-chips">
            {FEED_FEELINGS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={feeling === f.key ? 'sc-filter on' : 'sc-filter'}
                onClick={() => {
                  setFeeling(f.key);
                  setPicking(false);
                }}
                data-testid={`feeling-${f.key}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </form>
  );
}

/* ======================= A post and its comments ======================= */

export function PostPage() {
  const { id } = useParams();
  return (
    <section data-testid="post-page" className="sc-page feed-page">
      <TopBar title="Post" />
      <Gate>{() => <PostDetail id={id ?? ''} />}</Gate>
    </section>
  );
}

function PostDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const post = useLoad<{ post: FeedPost }>(`/api/feed/posts/${encodeURIComponent(id)}`);
  const comments = useLoad<{ comments: PostComment[] }>(`/api/feed/posts/${encodeURIComponent(id)}/comments`);
  const [msg, setMsg] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<PostComment | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [review, setReview] = useState<ReviewNote | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const confirm = useConfirm();
  if (post.error) return <p className="sc-meta">{post.error}</p>;
  const p = post.data?.post;
  if (!p) return <p className="sc-meta">Loading…</p>;
  const list = comments.data?.comments ?? [];
  const top = list.filter((c) => !c.parentId);
  const kids = (cid: number): PostComment[] => list.filter((c) => c.parentId === cid);
  const one = (c: PostComment, reply = false) => (
    <div key={c.id} className={reply ? 'sc-card sc-comment reply' : 'sc-card sc-comment'} data-testid="comment">
      <Link to={`/people/${c.author.userId}`} tabIndex={-1} aria-hidden="true">
        <Avatar a={c.author} size={reply ? 34 : 42} />
      </Link>
      <div className="sc-comment-main">
        <span>
          <Name a={c.author} /> <span className="sc-meta">· {since(c.at)}</span>
          {c.status !== 'visible' && <span className="sc-chip warn">Under review</span>}
        </span>
        <p>
          <RichText text={c.body} />
        </p>
        <span className="sc-comment-acts">
          <button
            type="button"
            className={c.likedByMe ? 'sc-act on' : 'sc-act'}
            aria-pressed={c.likedByMe}
            aria-label={c.likedByMe ? 'Unlike' : 'Like'}
            onClick={() =>
              void api<{ likes: number; likedByMe: boolean }>(`/api/feed/comments/${c.id}/like`, 'POST').then((r) => comments.setData({ comments: list.map((x) => (x.id === c.id ? { ...x, ...r } : x)) }))
            }
            data-testid="comment-like"
          >
            <Icon name="heart" size={18} filled={c.likedByMe} />
            {c.likes > 0 && <span>{c.likes}</span>}
          </button>
          {p.canComment && !reply && (
            <button
              type="button"
              className="sc-link small"
              onClick={() => {
                setReplyTo(c);
                setBody(c.author.username ? `@${c.author.username} ` : '');
                box.current?.focus();
              }}
              data-testid="comment-reply"
            >
              Reply
            </button>
          )}
          {(c.mine || p.mine) && (
            <button
              type="button"
              className="sc-link small muted"
              onClick={() => void confirm({ title: 'Delete this comment?', confirmLabel: 'Delete', danger: true }).then((y) => void (y && api(`/api/feed/comments/${c.id}`, 'DELETE').then(() => comments.reload())))}
            >
              Delete
            </button>
          )}
          {!c.mine && <ReportButton path={`/api/feed/comments/${c.id}/report`} onDone={setMsg} />}
        </span>
      </div>
    </div>
  );
  return (
    <div className="sc-post-page">
      <PostCard p={p} detail onChange={(np) => post.setData({ post: np })} onMsg={setMsg} onGone={() => navigate('/feed')} />
      {msg && (
        <p className="sc-toast" role="status" onClick={() => setMsg(null)}>
          {msg}
        </p>
      )}
      <h2 className="sc-h2" data-testid="comments-count">
        Comments ({p.comments ?? list.length})
      </h2>
      <div className="sc-list" data-testid="comments">
        {top.map((c) => [one(c), ...kids(c.id).map((k) => one(k, true))])}
        {comments.data && !list.length && <p className="sc-meta">{p.canComment ? 'No comments yet. Say something kind.' : 'No comments.'}</p>}
      </div>
      {review?.underReview && (
        <p className="sc-card sc-note" role="status" data-testid="under-review">
          <b>Under review.</b> A moderator will look before others can see your comment.
        </p>
      )}
      <BlockedNote b={blocked} />
      {p.canComment ? (
        <form
          className="sc-float-compose"
          onSubmit={(e) => {
            e.preventDefault();
            if (!body.trim()) return;
            setBusy(true);
            setBlocked(null);
            void api<{ review: ReviewNote }>(`/api/feed/posts/${p.id}/comments`, 'POST', { body, parentId: replyTo?.id ?? null })
              .then((r) => {
                setBody('');
                setReplyTo(null);
                setReview(r.review);
                comments.reload();
                post.reload();
              })
              .catch((e2: unknown) => (blockedOf(e2) ? setBlocked(blockedOf(e2)) : setMsg(errText(e2, 'Could not comment'))))
              .finally(() => setBusy(false));
          }}
        >
          {replyTo && (
            <button type="button" className="sc-replying" onClick={() => setReplyTo(null)}>
              Replying to {replyTo.author.displayName} <Icon name="x" size={12} />
            </button>
          )}
          <textarea ref={box} value={body} onChange={(e) => setBody(e.target.value)} rows={1} maxLength={1000} placeholder="Add a comment…" aria-label="Add a comment" data-testid="comment-input" />
          <button className="sc-send" disabled={busy || !body.trim()} aria-label="Send" data-testid="comment-send">
            <Icon name="send" size={22} />
          </button>
        </form>
      ) : (
        <p className="sc-meta sc-center" data-testid="comments-closed">
          {p.commentsFrom === 'nobody' ? 'Comments are off for this post.' : `Only ${p.author.displayName}’s friends can comment.`}
        </p>
      )}
    </div>
  );
}
