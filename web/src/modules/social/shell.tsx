/**
 * The small, always-loaded part of the Feed: where to land after "Join the Feed", and the header for
 * people who joined just for the Feed (no household). The Feed itself loads lazily (Social.tsx).
 */
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useLoad } from '../../api';
import { useSession } from '../../session';
import { FeedHorn, NavIcon } from '../../components/NavIcon';
import { api as apiCall } from '../../api';
import { setBadge } from './push';
import { signOut } from '../../signout';
import { APP_URL, clearInstall, FEED_APP, iosSafari, pendingInstall, standalone } from '../../apps';
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
  const { me } = useSession();
  // In the Feed app, MyDay is the other app (the family planner): its door, signed in (same account).
  const myday = FEED_APP && APP_URL ? `/api/auth/go?to=myday&next=${me.household ? '/' : '/start'}` : '/start';
  return (
    <header className="top social-top" data-testid="social-shell">
      <FeedHorn tile size={30} className="mark-horn" />
      <b>The Feed</b>
      <span className="grow" />
      <a href={myday} className="link light small" data-testid="setup-household">
        {FEED_APP && me.household ? 'MyDay' : 'Set up MyDay'}
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

/** New notifications (the bell's number, and the Feed app's home-screen badge): checked every minute. */
function useFeedUnread(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const check = (): void => {
      void apiCall<{ unread: number }>('/api/feed/notifications/count').then(
        (r) => {
          if (!live) return;
          setN(r.unread);
          if (FEED_APP) setBadge(r.unread);
        },
        () => undefined,
      );
    };
    check();
    const t = setInterval(check, 60_000);
    window.addEventListener('feed-notifications', check);
    window.addEventListener('focus', check);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener('feed-notifications', check);
      window.removeEventListener('focus', check);
    };
  }, []);
  return n;
}

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
  // Circles live with a household (people who joined just for the Feed don't have one), inside MyDay.
  const links = SECTIONS.filter((s) => !s.household || (!FEED_APP && me.household && !off.has('circles')));
  const unread = inbox.data?.unread ?? 0;
  const notes = useFeedUnread();
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
      <NavLink to="/notifications" className="feed-nav-link feed-nav-bell" aria-label={notes ? `Notifications, ${notes} new` : 'Notifications'} data-testid="notif-bell">
        <NavIcon name="bell" size={18} />
        {notes > 0 && (
          <span className="feed-nav-badge" data-testid="notif-badge">
            {notes > 99 ? '99+' : notes}
          </span>
        )}
      </NavLink>
    </nav>
  );
}

/* ---------- the Feed app: Add to Home Screen ---------- */

const INSTALL_KEY = 'feed.install.dismissed';

/**
 * "Put The Feed on your home screen": the browser's own install prompt where there is one (Chrome, Edge,
 * Android); on iPhone/iPad Safari, the two steps from the Share menu. Gone once installed or dismissed.
 */
export function InstallFeed() {
  const [offer, setOffer] = useState(pendingInstall);
  const [hidden, setHidden] = useState(() => standalone() || stored(INSTALL_KEY) === '1');
  const [steps, setSteps] = useState(false);
  useEffect(() => {
    const on = (): void => setOffer(pendingInstall());
    window.addEventListener('feed-install-ready', on);
    return () => window.removeEventListener('feed-install-ready', on);
  }, []);
  const ios = iosSafari();
  if (hidden || (!offer && !ios)) return null;
  const dismiss = (): void => {
    store(INSTALL_KEY, '1');
    setHidden(true);
  };
  const install = async (): Promise<void> => {
    if (!offer) {
      setSteps(true);
      return;
    }
    await offer.prompt();
    const choice = await offer.userChoice?.catch(() => null);
    clearInstall();
    setOffer(null);
    if (choice?.outcome !== 'dismissed') setHidden(true);
  };
  return (
    <section className="card feed-install" data-testid="feed-install" aria-label="Install The Feed">
      <FeedHorn tile size={48} />
      <div className="feed-install-text">
        <b>Put The Feed on your home screen</b>
        <span className="small muted">Opens like an app, with notifications when someone replies.</span>
      </div>
      <div className="feed-install-actions">
        <button type="button" className="btn" onClick={() => void install()} data-testid="feed-install-go">
          {offer ? 'Install' : 'How'}
        </button>
        <button type="button" className="link small" onClick={dismiss} aria-label="Not now">
          Not now
        </button>
      </div>
      {steps && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setSteps(false)}>
          <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="install-steps-title" data-testid="install-steps">
            <h2 id="install-steps-title">Add The Feed to your home screen</h2>
            <ol className="install-steps">
              <li>
                Tap <b>Share</b> (the square with an arrow) at the bottom of Safari.
              </li>
              <li>
                Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.
              </li>
            </ol>
            <p className="small muted">The horn icon opens The Feed full-screen, signed in.</p>
            <div className="confirm-actions">
              <button type="button" className="btn" onClick={() => setSteps(false)}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
