/**
 * Search the Feed: people (name or @username), posts (words or #hashtag) and villages — and, before you type,
 * what's being talked about this week (topics). #tags and @names in posts link here.
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { FeedPost, FeedSearch } from '@myday/shared';
import { api } from '../../api';
import { count } from '../../format';
import { NavIcon } from '../../components/NavIcon';
import { FeedCard, Gate } from '../community/Community';
import { FeedNav, FeedTitle } from './shell';

type Tab = 'all' | 'people' | 'posts' | 'villages';

export function SearchPage() {
  return (
    <section className="feed-page" data-testid="feed-search-page">
      <FeedTitle>Search</FeedTitle>
      <FeedNav />
      <Gate>{() => <Search />}</Gate>
    </section>
  );
}

function Search() {
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
  const follow = async (userId: number, on: boolean): Promise<void> => {
    await api(`/api/community/people/${userId}/follow`, on ? 'DELETE' : 'POST');
    setRes((r) => (r ? { ...r, people: r.people.map((x) => (x.userId === userId ? { ...x, followedByMe: !on, followers: x.followers + (on ? -1 : 1) } : x)) } : r));
  };
  const show = (t: Tab): boolean => tab === 'all' || tab === t;
  const empty = res && res.q.length >= 2 && !res.people.length && !res.posts.length && !res.villages.length;
  return (
    <>
      <form
        className="feed-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(q ? { q } : {});
        }}
      >
        <NavIcon name="search" size={18} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="People, #topics, posts, villages" aria-label="Search the Feed" autoFocus data-testid="search-input" />
      </form>
      {res && res.q.length >= 2 && (
        <div className="chips" role="tablist" aria-label="Show">
          {(['all', 'people', 'posts', 'villages'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'chip on' : 'chip'} onClick={() => setTab(t)} data-testid={`search-tab-${t}`}>
              {t === 'all' ? 'All' : t[0]?.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      )}
      {res && res.topics.length > 0 && (
        <div className="search-topics" data-testid="search-topics">
          <h2 className="eyebrow">{res.q.length >= 2 ? 'Topics' : 'Talked about this week'}</h2>
          <div className="chips">
            {res.topics.map((t) => (
              <Link key={t.tag} to={`/search?q=${encodeURIComponent(`#${t.tag}`)}`} className="chip" data-testid="search-topic">
                #{t.tag} <small className="muted">{t.count}</small>
              </Link>
            ))}
          </div>
        </div>
      )}
      {msg && (
        <p className="muted" role="status">
          {msg}
        </p>
      )}
      {res && show('people') && res.people.length > 0 && (
        <div data-testid="search-people">
          <h2 className="eyebrow">People</h2>
          <ul className="plain onb-list">
            {res.people.map((p) => (
              <li key={p.userId} className="row-card" data-testid="search-person">
                <span className="ring-avatar" aria-hidden="true" style={{ width: 44, height: 44, fontSize: 18 }}>
                  {p.displayName.slice(0, 1)}
                </span>
                <Link to={`/people/${p.userId}`} className="grow notif-text">
                  <b>{p.displayName}</b> {p.username && <small className="muted">@{p.username}</small>}
                  <small className="muted" style={{ display: 'block' }}>
                    {count(p.followers, 'follower')}
                  </small>
                </Link>
                <button type="button" className={p.followedByMe ? 'btn small' : 'btn ghost small'} onClick={() => void follow(p.userId, p.followedByMe)} data-testid="search-follow">
                  {p.followedByMe ? 'Following' : 'Follow'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {res && show('villages') && res.villages.length > 0 && (
        <div data-testid="search-villages">
          <h2 className="eyebrow">Villages</h2>
          <ul className="plain onb-list">
            {res.villages.map((v) => (
              <li key={v.slug} className="row-card">
                <Link to="/village" className="grow notif-text" onClick={() => localStorage.setItem('myday.village', v.slug)}>
                  <b>{v.name}</b>
                  <small className="muted" style={{ display: 'block' }}>
                    {v.description} · {count(v.members, 'member')}
                  </small>
                </Link>
                {v.joined && <span className="pill">Joined</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {res && show('posts') && res.posts.length > 0 && (
        <div data-testid="search-posts">
          <h2 className="eyebrow">Posts</h2>
          {res.posts.map((p) => (
            <FeedCard key={p.id} p={p} onChange={setPost} onMsg={setMsg} onGone={(id) => setRes((r) => (r ? { ...r, posts: r.posts.filter((x) => x.id !== id) } : r))} />
          ))}
        </div>
      )}
      {empty && (
        <p className="muted" data-testid="search-empty">
          Nothing for “{res.q}” yet. Try a first name, an @username or a #topic.
        </p>
      )}
    </>
  );
}
