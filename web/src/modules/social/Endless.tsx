/**
 * The bottomless Feed: page after page as you scroll (no "load more", no end). When the posts run out it carries
 * on with suggested posts and village conversations; past even those, people and villages to discover, and it
 * keeps checking for new posts.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { CHECKIN_MOODS, type FeedCatchup, type FeedMemory, type FeedPage, type FeedPost, type FeedSort, type FeedStats, type FeedStreakInfo, type FeedSuggestion, type FeedVillageItem, type SponsoredItem } from '@myday/shared';
import { api, useLoad } from '../../api';
import { ago } from '../../dates';
import { count } from '../../format';
import { PeopleRail } from './Growth';

type Card = { kind: 'post'; post: FeedPost } | { kind: 'village'; v: FeedVillageItem };

export function EndlessPosts({
  tab,
  sort,
  onSort,
  renderPost,
  renderSponsored,
}: {
  /** A chronological tab; without one the Feed is the ranked home feed (or Latest, if that's the person's choice). */
  tab?: 'following' | 'everyone';
  /** Switch order (remembered on the server); omitted = the saved choice. */
  sort?: FeedSort;
  onSort?: (s: FeedSort) => void;
  renderPost: (p: FeedPost, update: (p: FeedPost) => void, gone: (id: number) => void) => React.ReactNode;
  renderSponsored: (s: SponsoredItem) => React.ReactNode;
}) {
  const [cards, setCards] = useState<Card[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [sponsored, setSponsored] = useState<SponsoredItem | null>(null);
  const [busy, setBusy] = useState(false);
  // Ranked: "You're caught up" once every scored post has been shown; "Keep exploring" goes on (older posts, villages).
  const [caughtUp, setCaughtUp] = useState<{ explore: string | null } | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const base = tab ? `/api/feed?tab=${tab}` : `/api/feed?${sort ? `sort=${sort}` : ''}`;
  const more = useCallback(async (): Promise<void> => {
    if (loading.current || cursor === null || caughtUp) return;
    loading.current = true;
    setBusy(true);
    try {
      const page = await api<FeedPage>(`${base}${cursor ? `${base.endsWith('?') ? '' : '&'}cursor=${encodeURIComponent(cursor)}` : ''}`);
      const add: Card[] = [...page.posts.map((post) => ({ kind: 'post' as const, post })), ...(page.villages ?? []).map((v) => ({ kind: 'village' as const, v }))];
      setCards((c) => {
        const seen = new Set(c.map((x) => (x.kind === 'post' ? `p${x.post.id}` : `v${x.v.id}`)));
        return [...c, ...add.filter((x) => !seen.has(x.kind === 'post' ? `p${x.post.id}` : `v${x.v.id}`))];
      });
      if (cursor === undefined && page.sponsored) setSponsored(page.sponsored);
      if (cursor === undefined && page.sort) onSort?.(page.sort);
      if (page.caughtUp) {
        setCaughtUp({ explore: page.exploreCursor ?? null });
        setCursor(null);
      } else setCursor(page.cursor ?? null);
    } finally {
      loading.current = false;
      setBusy(false);
    }
  }, [cursor, base, caughtUp]); // eslint-disable-line react-hooks/exhaustive-deps
  // First page, then the next one whenever the bottom comes into view.
  useEffect(() => {
    if (cursor === undefined) void more();
  }, [cursor, more]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || cursor === null) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void more(), { rootMargin: '900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, cursor]);
  // Past the very end of a chronological stream: keep checking for new posts (they appear at the top).
  useEffect(() => {
    if (cursor !== null || caughtUp) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void api<FeedPage>(`/api/feed?tab=${tab ?? 'everyone'}`).then((page) =>
        setCards((c) => {
          const have = new Set(c.filter((x) => x.kind === 'post').map((x) => (x as { post: FeedPost }).post.id));
          const fresh = page.posts.filter((p) => !have.has(p.id) && !p.discover);
          return fresh.length ? [...fresh.map((post) => ({ kind: 'post' as const, post })), ...c] : c;
        }),
      );
    }, 45_000);
    return () => clearInterval(t);
  }, [cursor, tab, caughtUp]);
  const update = (p: FeedPost): void => setCards((c) => c.map((x) => (x.kind === 'post' && x.post.id === p.id ? { kind: 'post', post: p } : x)));
  const gone = (id: number): void => setCards((c) => c.filter((x) => !(x.kind === 'post' && x.post.id === id)));
  let discoverShown = false;
  let villagesShown = false;
  return (
    <div className="slips" data-testid="feed-posts">
      {cards.map((card, i) => {
        if (card.kind === 'village') {
          const head = !villagesShown;
          villagesShown = true;
          return (
            <Fragment key={`v${card.v.id}`}>
              {head && <h3 className="eyebrow centered feed-divider">From the villages</h3>}
              <Link to={`/village/${card.v.id}`} className="card thread-row feed-village-card" data-testid="feed-village-card">
                <b>{card.v.title}</b>
                <small className="muted" style={{ display: 'block' }}>
                  {card.v.village} · {card.v.author.displayName} · {count(card.v.replies, 'reply', 'replies')} · {ago(card.v.at)}
                </small>
              </Link>
            </Fragment>
          );
        }
        const head = card.post.discover && !discoverShown;
        if (card.post.discover) discoverShown = true;
        return (
          <Fragment key={`p${card.post.id}`}>
            {head && (
              <h3 className="eyebrow centered feed-divider" data-testid="feed-discover">
                Suggested for you
              </h3>
            )}
            {renderPost(card.post, update, gone)}
            {i === 1 && sponsored && renderSponsored(sponsored)}
            {i === 4 && <PeopleRail />}
          </Fragment>
        );
      })}
      {caughtUp ? (
        <div className="sc-card feed-caught-up" data-testid="feed-caught-up">
          <b>You’re caught up</b>
          <p className="sc-meta">That’s everything new from your friends and the community this week. Nothing more is loading — come back later, or keep going if you want to.</p>
          {caughtUp.explore && (
            <button
              type="button"
              className="sc-btn outline small"
              onClick={() => {
                const next = caughtUp.explore;
                setCaughtUp(null);
                setCursor(next);
              }}
              data-testid="feed-explore-more"
            >
              Keep exploring
            </button>
          )}
        </div>
      ) : cursor === null ? (
        <KeepGoing />
      ) : (
        <div ref={sentinel} className="feed-sentinel" data-testid="feed-more" aria-hidden="true" />
      )}
      {busy && <p className="muted desk-note">Loading more…</p>}
    </div>
  );
}

/** Past the very end: people and villages to discover, and new posts land on top as they come. */
function KeepGoing() {
  const { data } = useLoad<{ people: FeedSuggestion[] }>('/api/feed/suggestions?limit=6');
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  return (
    <div className="feed-keepgoing" data-testid="feed-keepgoing">
      <h3 className="eyebrow centered feed-divider">Find more of your people</h3>
      <ul className="plain onb-list">
        {data?.people.map((p) => (
          <li key={p.userId} className="row-card">
            <span className="ring-avatar" aria-hidden="true" style={{ width: 40, height: 40, fontSize: 16 }}>
              {p.displayName.slice(0, 1)}
            </span>
            <Link to={`/people/${p.userId}`} className="grow notif-text">
              <b>{p.displayName}</b>
              <small className="muted" style={{ display: 'block' }}>
                {p.reason}
              </small>
            </Link>
            <button
              type="button"
              className={followed.has(p.userId) ? 'btn small' : 'btn ghost small'}
              onClick={() => void api(`/api/community/people/${p.userId}/follow`, 'POST').then(() => setFollowed(new Set([...followed, p.userId])))}
            >
              {followed.has(p.userId) ? 'Following' : 'Follow'}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small centered">
        <Link to="/village">Browse the villages</Link> · <Link to="/search">Search topics</Link> · new posts show up here as they’re written.
      </p>
    </div>
  );
}

/* ---------- the top of the Feed: your streak, a memory, what you missed ---------- */

export function StreakChip() {
  const { data, setData } = useLoad<FeedStreakInfo>('/api/feed/streak');
  const [open, setOpen] = useState(false);
  if (!data) return null;
  const checkin = (mood: string): void => {
    void api<FeedStreakInfo>('/api/feed/checkin', 'POST', { mood }).then((s) => {
      setData(s);
      setOpen(false);
    });
  };
  return (
    <div className="streak-chip" data-testid="streak-chip">
      <span className="streak-flame" aria-hidden="true">
        🔥
      </span>
      <span className="grow">
        <b data-testid="streak-count">{count(data.current, 'day')}</b> streak
        <small className="muted" style={{ display: 'block' }}>
          {data.todayDone ? 'Today counts.' : 'Post or check in to keep it going.'} {data.restDayUsed ? 'Rest day used this week.' : 'One rest day a week is on us.'}
        </small>
      </span>
      {!data.todayDone &&
        (open ? (
          <span className="chips" role="group" aria-label="How’s today?">
            {CHECKIN_MOODS.map((m) => (
              <button key={m.key} type="button" className="chip" onClick={() => checkin(m.key)} data-testid={`mood-${m.key}`}>
                {m.label}
              </button>
            ))}
          </span>
        ) : (
          <button type="button" className="btn small" onClick={() => setOpen(true)} data-testid="checkin">
            Check in
          </button>
        ))}
    </div>
  );
}

export function MemoriesCard({ renderPost }: { renderPost: (p: FeedPost) => React.ReactNode }) {
  const { data, setData } = useLoad<{ memories: FeedMemory[] }>('/api/feed/memories');
  const m = data?.memories[0];
  if (!m) return null;
  return (
    <section className="card memory-card" data-testid="memory-card" aria-label="A memory">
      <div className="row">
        <b className="grow">{m.yearsAgo === 1 ? 'A year ago today' : `${m.yearsAgo} years ago today`}</b>
        <button type="button" className="link small" onClick={() => void api('/api/feed/memories/seen', 'POST').then(() => setData({ memories: [] }))} data-testid="memory-dismiss">
          Done
        </button>
      </div>
      {renderPost(m.post)}
    </section>
  );
}

export function CatchupCard({ renderPost }: { renderPost: (p: FeedPost) => React.ReactNode }) {
  const { data, setData } = useLoad<{ catchup: FeedCatchup | null }>('/api/feed/catchup');
  const c = data?.catchup;
  if (!c) return null;
  const bits = [
    c.newPosts && `${count(c.newPosts, 'new post')} from people you follow`,
    c.replies && `${count(c.replies, 'reply', 'replies')} to you`,
    c.newFollowers && count(c.newFollowers, 'new follower'),
    c.villageConversations && `${count(c.villageConversations, 'conversation')} in your villages`,
  ].filter(Boolean);
  return (
    <section className="card catchup-card" data-testid="catchup-card" aria-label="While you were away">
      <div className="row">
        <b className="grow">Welcome back — here’s what you missed</b>
        <button type="button" className="link small" onClick={() => void api('/api/feed/catchup/seen', 'POST').then(() => setData({ catchup: null }))} data-testid="catchup-dismiss">
          Got it
        </button>
      </div>
      <p className="small muted">{bits.length ? `${bits.join(' · ')} in the last ${count(c.days, 'day')}.` : `It’s been ${count(c.days, 'day')} — good to see you.`}</p>
      {c.top.map((p) => (
        <Fragment key={p.id}>{renderPost(p)}</Fragment>
      ))}
    </section>
  );
}

/** Your own numbers (your profile's About tab — only you see it). */
export function YourStats() {
  const { data } = useLoad<FeedStats>('/api/feed/stats');
  if (!data) return null;
  const tiles: Array<[string, number, string]> = [
    ['posts', data.posts, 'posts'],
    ['likes', data.likesReceived, 'likes received'],
    ['followers', data.followers, `followers (+${data.newFollowers7d} this week)`],
    ['views', data.profileViews7d, 'profile views this week'],
    ['reads', data.postViews7d, 'post views this week'],
    ['replies', data.repliesGiven, 'replies you gave'],
    ['streak', data.streak.current, `day streak (best ${data.streak.best})`],
    ['villages', data.villagesJoined, 'villages'],
  ];
  return (
    <section className="card your-stats" data-testid="your-stats" aria-label="Your stats">
      <small className="label">Your stats — only you see these</small>
      <div className="stats-grid">
        {tiles.map(([k, n, label]) => (
          <div key={k} className="stat-tile" data-testid={`stat-${k}`}>
            <b>{n}</b>
            <small className="muted">{label}</small>
          </div>
        ))}
      </div>
    </section>
  );
}
