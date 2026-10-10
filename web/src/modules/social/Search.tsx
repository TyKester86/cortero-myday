/**
 * Search the Feed: people (name or @username), posts (words or #hashtag), groups (villages) and media — and,
 * before you type, what's being talked about this week (topics). #tags and @names in posts link here.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { FeedPost, FeedSearch } from '@myday/shared';
import { api } from '../../api';
import { count } from '../../format';
import { Gate } from '../community/Community';
import { Avatar, Filters, FriendButton, Icon, Name, relOf, short } from '../feed/kit';
import { PostCard } from '../feed/PostCard';

type Tab = 'all' | 'people' | 'posts' | 'villages' | 'media';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'people', label: 'People' },
  { key: 'posts', label: 'Posts' },
  { key: 'villages', label: 'Groups' },
  { key: 'media', label: 'Media' },
];

export function SearchPage() {
  return (
    <section className="sc-page feed-page" data-testid="feed-search-page">
      <Gate>{() => <Search />}</Gate>
    </section>
  );
}

function Search() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [tab, setTab] = useState<Tab>('all');
  const [res, setRes] = useState<FeedSearch | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Follows the address (a tapped #tag) and what's typed, a beat after typing stops.
  useEffect(() => {
    const p = params.get('q') ?? '';
    if (p !== q) setQ(p);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => {
      void api<FeedSearch>(`/api/feed/search?q=${encodeURIComponent(q.trim())}`).then(setRes, () => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const setPost = (p: FeedPost): void => setRes((r) => (r ? { ...r, posts: r.posts.map((x) => (x.id === p.id ? p : x)) } : r));
  const show = (t: Tab): boolean => tab === 'all' || tab === t;
  const media = res?.posts.filter((p) => p.imageUrl) ?? [];
  const empty = res && res.q.length >= 2 && !res.people.length && !res.posts.length && !res.villages.length;
  return (
    <>
      <header className="sc-bar search">
        <button type="button" className="sc-icon-btn" aria-label="Back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/feed'))}>
          <Icon name="back" />
        </button>
        <form
          className="sc-search grow"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setParams(q ? { q } : {});
          }}
        >
          <Icon name="search" size={20} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="People, #topics, posts, groups" aria-label="Search the Feed" autoFocus data-testid="search-input" />
          {q && (
            <button type="button" className="sc-icon-btn sm" aria-label="Clear" onClick={() => setQ('')}>
              <Icon name="x" size={18} />
            </button>
          )}
        </form>
      </header>
      {res && res.q.length >= 2 && (
        <>
          <h1 className="sc-h2">Search results</h1>
          <Filters items={TABS} on={tab} onPick={setTab} testid={(t) => `search-tab-${t}`} />
        </>
      )}
      {res && res.topics.length > 0 && (tab === 'all' || res.q.length < 2) && (
        <div data-testid="search-topics">
          <h2 className="sc-h3">{res.q.length >= 2 ? 'Topics' : 'Talked about this week'}</h2>
          <div className="sc-chips">
            {res.topics.map((t) => (
              <Link key={t.tag} to={`/search?q=${encodeURIComponent(`#${t.tag}`)}`} className="sc-chip-outline" data-testid="search-topic">
                #{t.tag} <small>{t.count}</small>
              </Link>
            ))}
          </div>
        </div>
      )}
      {msg && (
        <p className="sc-toast" role="status" onClick={() => setMsg(null)}>
          {msg}
        </p>
      )}
      {res && show('people') && res.people.length > 0 && (
        <div data-testid="search-people">
          <h2 className="sc-h3">People</h2>
          <div className="sc-card sc-rows">
            {res.people.map((p) => (
              <div key={p.userId} className="sc-row-item" data-testid="search-person">
                <Link to={`/people/${p.userId}`} className="sc-person-who grow">
                  <Avatar a={p} size={48} />
                  <span>
                    <Name a={p} link={false} />
                    <small className="sc-meta">
                      {p.username ? `@${p.username} · ` : ''}
                      {p.mutualFriends ? `${p.mutualFriends} mutual` : `${short(p.friends ?? 0)} ${(p.friends ?? 0) === 1 ? 'friend' : 'friends'}`}
                    </small>
                  </span>
                </Link>
                <FriendButton
                  userId={p.userId}
                  rel={relOf(p.followedByMe, !!p.followsMe)}
                  compact
                  testid="search-follow"
                  onChange={(r) => setRes((x) => (x ? { ...x, people: x.people.map((y) => (y.userId === p.userId ? { ...y, followedByMe: r === 'friends' || r === 'requested' } : y)) } : x))}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {res && show('posts') && res.posts.length > 0 && (
        <div data-testid="search-posts" className="sc-list">
          <h2 className="sc-h3">Posts</h2>
          {res.posts.map((p) => (
            <PostCard key={p.id} p={p} onChange={setPost} onMsg={setMsg} onGone={(id) => setRes((r) => (r ? { ...r, posts: r.posts.filter((x) => x.id !== id) } : r))} />
          ))}
        </div>
      )}
      {res && show('villages') && res.villages.length > 0 && (
        <div data-testid="search-villages">
          <h2 className="sc-h3">Groups</h2>
          <div className="sc-card sc-rows">
            {res.villages.map((v) => (
              <div key={v.slug} className="sc-row-item">
                <Link to="/village" className="grow sc-notif-text" onClick={() => localStorage.setItem('myday.village', v.slug)}>
                  <b>{v.name}</b>
                  <small className="sc-meta">
                    {v.description} · {count(v.members, 'member')}
                  </small>
                </Link>
                {v.joined ? (
                  <span className="sc-chip">Joined</span>
                ) : (
                  <button
                    type="button"
                    className="sc-btn outline small"
                    onClick={() =>
                      void api(`/api/villages/${v.slug}/members`, 'POST').then(() => setRes((r) => (r ? { ...r, villages: r.villages.map((x) => (x.slug === v.slug ? { ...x, joined: true } : x)) } : r)))
                    }
                    data-testid="search-join"
                  >
                    Join
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {res && tab === 'media' && (
        <div className="sc-grid" data-testid="search-media">
          {media.map((p) => (
            <Link key={p.id} to={`/feed/post/${p.id}`} className="sc-tile">
              <img src={p.imageUrl ?? ''} alt="" loading="lazy" />
            </Link>
          ))}
          {!media.length && <p className="sc-meta">No photos match.</p>}
        </div>
      )}
      {empty && (
        <p className="sc-meta" data-testid="search-empty">
          Nothing for “{res.q}” yet. Try a first name, an @username or a #topic.
        </p>
      )}
    </>
  );
}
