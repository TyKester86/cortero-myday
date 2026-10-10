/**
 * The small, always-loaded part of the Feed: where to land after "Join the Feed", and the header for
 * people who joined just for the Feed (no household). The Feed itself loads lazily (Social.tsx).
 */
import { useEffect, useState } from 'react';
import { FeedHorn } from '../../components/NavIcon';
import { api as apiCall } from '../../api';
import { setBadge } from './push';
import { clearInstall, FEED_APP, iosSafari, pendingInstall, standalone } from '../../apps';
import { TopBar } from '../feed/kit';
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

/** A Feed page's title: the Soft Card header (back, the horn, the title). */
export function FeedTitle({ children }: { children: ReactNode }) {
  return <TopBar title={children} />;
}

/* ---------- the Feed's section bar ---------- */

/** New notifications (the bell's number, and the Feed app's home-screen badge): checked every minute. */
export function useFeedUnread(): number {
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

/** The old section bar: the dock (Home · Friends · + · Profile · Bell) does its job now. */
export function FeedNav() {
  return null;
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
