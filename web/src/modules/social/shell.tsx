/**
 * The small, always-loaded part of the Feed: where to land after "Join the Feed", and the header for
 * people who joined just for the Feed (no household). The Feed itself loads lazily (Social.tsx).
 */
import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';
import { FeedHorn } from '../../components/NavIcon';
import type { ReactNode } from 'react';

export const AGE_KEY = 'myday.feed18';
export const NEXT_KEY = 'myday.next';

export function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function store(key: string, v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* a convenience only */
  }
}

/** Where to land after signing in (set by "Join the Feed"); read once. */
export function takeNext(): string | null {
  const v = stored(NEXT_KEY);
  if (v) store(NEXT_KEY, null);
  return v && /^\/[a-z/]*$/.test(v) ? v : null;
}

/** Header for a Feed-only account: the Feed, and a way to set up the rest of MyDay later. */
export function SocialHeader() {
  const signOut = async (): Promise<void> => {
    await api('/api/auth/logout', 'POST').catch(() => undefined);
    navigator.serviceWorker?.controller?.postMessage('clear-api');
    window.location.href = '/';
  };
  return (
    <header className="top social-top" data-testid="social-shell">
      <FeedHorn tile size={30} className="mark-horn" />
      <b>The Feed</b>
      <span className="grow" />
      <a href="/start" className="link light small" data-testid="setup-household">
        Set up MyDay
      </a>
      <button type="button" className="link light small" onClick={() => void signOut()}>
        Sign out
      </button>
    </header>
  );
}

/** A Feed page's title, with the Feed's own mark (the bulb horn — never the MyDay mark). */
export function FeedTitle({ children }: { children: ReactNode }) {
  return (
    <header className="page-head feed-head">
      <FeedHorn tile size={52} className="feed-head-mark" />
      <h1 className="page-title">{children}</h1>
    </header>
  );
}

/* ---------- the Feed's section bar ---------- */

const SECTIONS: Array<{ to: string; label: string; end?: boolean; household?: boolean }> = [
  { to: '/feed', label: 'Feed', end: true },
  { to: '/feed/stories', label: 'Stories' },
  { to: '/clips', label: 'Clips' },
  { to: '/messages', label: 'Messages' },
  { to: '/circles', label: 'Circles', household: true },
  { to: '/village', label: 'Villages' },
];

/** One navigation for everything social: Feed · Stories · Clips · Messages · Circles · Villages. */
export function FeedNav() {
  const { me } = useSession();
  const inbox = useLoad<{ unread: number }>('/api/social/messages');
  const off = new Set(me.household?.modulesOff ?? []);
  // Circles live with a household (people who joined just for the Feed don't have one).
  const links = SECTIONS.filter((s) => !s.household || (me.household && !off.has('circles')));
  const unread = inbox.data?.unread ?? 0;
  const bar = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // The section you're in is always visible in the bar (it scrolls sideways on phones).
  useEffect(() => {
    const el = bar.current;
    const on = el?.querySelector<HTMLElement>('.active');
    if (el && on) el.scrollLeft = on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2;
  }, [pathname]);
  return (
    <nav className="feed-nav" aria-label="The Feed" data-testid="feed-nav" ref={bar}>
      {links.map((s) => (
        <NavLink key={s.to} to={s.to} end={s.end} className="feed-nav-link">
          {s.to === '/feed' && <FeedHorn size={16} />}
          {s.label}
          {s.to === '/messages' && unread > 0 && (
            <span className="feed-nav-badge" data-testid="dm-unread" aria-label={`${unread} unread`}>
              {unread}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
