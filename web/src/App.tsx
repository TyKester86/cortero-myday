import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import type { ModuleKey } from '@myday/shared';
import { useOffline } from './api';
import FirstRun from './components/FirstRun';
import Shortcuts from './components/Shortcuts';
import { CreateHousehold } from './Onboarding';
import { PendingInvitePrompt } from './components/JoinFlow';
import Admin from './modules/billing/Admin';
import { Moderation } from './modules/circles/Circles';
import { ProPortal } from './modules/care/Care';
import { useWide } from './modules/desk/Home';
import { applyLook } from './modules/settings/Settings';
import { ConfirmProvider } from './components/Confirm';
import Join from './Join';
import { Privacy, Terms } from './Legal';
import Login from './Login';
import { navFor } from './modules/nav';
import { MODULES, MyProfilePage } from './modules';
import { takeNext, useFeedUnread } from './modules/social/shell';
import { Dock } from './modules/feed/kit';
import './modules/feed/softcard.css';
import { APP_URL, FEED_APP, FEED_URL, standalone } from './apps';
import { signOut } from './signout';
import { FeedHorn, HanaFace, NavIcon } from './components/NavIcon';
import { useKeyboardLayout } from './components/useKeyboard';
import GroceryPopout from './modules/meals/GroceryPopout';
import { useRecordingUploads } from './recordings';
import { SessionProvider, useSession } from './session';

function OfflineBar() {
  const { online, queued } = useOffline();
  if (online && queued === 0) return null;
  return (
    <div className="offline" role="status" data-testid="offline-bar">
      {online ? `Syncing ${queued} saved change${queued === 1 ? '' : 's'}…` : `Offline — showing what's saved on this device${queued ? ` · ${queued} change${queued === 1 ? '' : 's'} will sync` : ''}`}
    </div>
  );
}

/** Sub-tabs inside a section, so related pages are one tap apart (grown-ups). */
const SECTIONS: Array<{ paths: string[]; links: Array<{ to: string; label: string; module?: ModuleKey; kids?: boolean }> }> = [
  {
    paths: ['/weekly', '/calendar', '/meals', '/meals/plan', '/meals/grocery'],
    links: [
      { to: '/weekly', label: 'Week' },
      { to: '/calendar', label: 'Calendar' },
      { to: '/meals', label: 'Meals', module: 'meals' },
      { to: '/meals/plan', label: 'This week’s menu', module: 'meals' },
      { to: '/meals/grocery', label: 'Grocery list', module: 'meals' },
    ],
  },
  {
    paths: ['/family', '/chores/manage', '/homework', '/rewards', '/my-money', '/wins', '/household'],
    links: [
      { to: '/family', label: 'Overview' },
      { to: '/chores/manage', label: 'Chores' },
      { to: '/homework', label: 'Homework', kids: true },
      { to: '/rewards', label: 'Rewards', kids: true },
      { to: '/my-money', label: 'Kid money', kids: true },
      { to: '/wins', label: 'Wins' },
      { to: '/household', label: 'Household' },
    ],
  },
  {
    paths: ['/money', '/bills', '/invest'],
    links: [
      { to: '/money', label: 'Accounts', module: 'money' },
      { to: '/bills', label: 'Bills & income', module: 'money' },
      { to: '/invest', label: 'Investments', module: 'invest' },
    ],
  },
];

function SectionTabs({ path }: { path: string }) {
  const { me } = useSession();
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const sec = SECTIONS.find((s) => s.paths.includes(clean));
  if (!sec) return null;
  const off = new Set(me.household?.modulesOff ?? []);
  const links = sec.links.filter((l) => !(l.module && off.has(l.module)) && !(l.kids && !me.household?.hasKids));
  if (links.length < 2) return null;
  return (
    <nav className="subtabs" aria-label="In this section">
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end>
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The bulb horn on MyDay's tab bar: the front door to the Feed. With the Feed app on its own domain it's a plain
 * link (a tap the phone can hand to the installed Feed app) that signs you in there — no login wall. Grown-ups only.
 */
function HornTab({ side = false }: { side?: boolean }) {
  const body = (
    <>
      <FeedHorn size={side ? 20 : 24} className="navicon" />
      {side ? ' The Feed' : <small>Feed</small>}
    </>
  );
  if (!FEED_URL) {
    return (
      <NavLink to="/feed" className="horn-tab" data-testid="horn-tab">
        {body}
      </NavLink>
    );
  }
  return (
    <a href="/api/auth/go?to=feed" className="horn-tab" data-testid="horn-tab" target={standalone() ? '_blank' : undefined} rel="noopener">
      {body}
    </a>
  );
}

function Shell() {
  const { me, viewable, viewing, setViewing, isAdult } = useSession();
  const [find, setFind] = useState('');
  const wide = useWide();
  const location = useLocation();
  // Phones: the tab bar stays behind the keyboard; the Ask Hana input rides on top of it.
  useKeyboardLayout();
  // Lecture recordings saved on this device upload on their own (load, reconnect, back to the app).
  useRecordingUploads(me.member ? me.userId : null);
  useEffect(() => {
    applyLook(me.prefs?.theme ?? 'system', me.prefs?.accent ?? 'navy');
  }, [me.prefs]);
  const nav = navFor(me);
  // Grown-ups on a desktop get a sidebar instead of the phone's bottom bar (everything else: the Me tab).
  const sidebar = wide && isAdult;
  const needle = find.trim().toLowerCase();
  const groupedLinks = (onPick?: () => void) =>
    nav.groups.map((g) => {
      const items = needle ? g.items.filter((i) => i.label.toLowerCase().includes(needle)) : g.items;
      if (!items.length) return null;
      return (
        <div key={g.key} className="navgroup">
          <small className="navgroup-label">{g.label}</small>
          {items.map((i) => (
            <NavLink key={i.path} to={i.path} end={i.path === '/'} onClick={onPick}>
              <NavIcon name={i.icon} /> {i.label}
            </NavLink>
          ))}
        </div>
      );
    });
  const sideTabs = sidebar ? nav.tabs.map((t) => ({ ...t, group: 'today' as const })) : [];
  if (isAdult && FEED_ROUTE.test(location.pathname)) {
    return (
      <FeedShell profileTo={me.userId ? `/people/${me.userId}` : '/feed'}>
        <Routes>
          {nav.routes.map((m) => (
            <Route key={m.path} path={m.path} element={m.element} />
          ))}
          <Route path="*" element={<p className="sc-meta">Page not found.</p>} />
        </Routes>
      </FeedShell>
    );
  }
  return (
    <div className={sidebar ? 'app wide sidebar' : 'app'}>
      <OfflineBar />
      <header className="top">
        {/* Feed pages wear the Feed's own mark (the bulb horn), never the MyDay mark. */}
        {FEED_ROUTE.test(location.pathname) ? (
          <>
            <FeedHorn tile size={30} className="mark-horn" />
            <b>The Feed</b>
          </>
        ) : (
          <>
            <img src="/icons/myday-mark.svg" alt="" className="mark" />
            <b>MyDay</b>
          </>
        )}
        {isAdult && viewable.length > 1 ? (
          <select aria-label="Whose day" value={viewing?.key ?? ''} onChange={(e) => setViewing(e.target.value)}>
            {viewable.map((m) => (
              <option key={m.key} value={m.key}>
                {m.key === me.member?.key ? `${m.name} (me)` : m.name}
              </option>
            ))}
          </select>
        ) : (
          // Your name opens Me: every page, your settings, Sign out (there is no menu button).
          <Link to="/me" className="who" data-testid="who">
            {me.member?.name ?? me.name}
          </Link>
        )}
      </header>
      {sidebar && (
        <aside className="side" data-testid="sidebar">
          <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find…" aria-label="Find a page" />
          <div className="navgroup">
            {sideTabs
              .filter((t) => !needle || t.label.toLowerCase().includes(needle))
              .map((t) => (
                <NavLink key={t.path} to={t.path} end={t.path === '/'}>
                  <NavIcon name={t.icon} /> {t.label}
                </NavLink>
              ))}
            {isAdult && (!needle || 'the feed'.includes(needle)) && <HornTab side />}
          </div>
          {groupedLinks()}
          <button className="link small" onClick={() => void signOut()}>
            Sign out
          </button>
        </aside>
      )}
      <main>
        {isAdult && <SectionTabs path={location.pathname} />}
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Routes>
            {nav.routes.map((m) => (
              <Route key={m.path} path={m.path} element={m.element} />
            ))}
            <Route path="*" element={<p className="muted">Page not found.</p>} />
          </Routes>
        </Suspense>
      </main>
      <FirstRun />
      <Shortcuts enabled={wide} />
      {nav.hana && location.pathname !== '/hana' && !location.pathname.startsWith('/messages/') && (
        <Link to="/hana" className="hana-fab" aria-label="Ask Hana" data-testid="hana-fab">
          <HanaFace size={52} />
        </Link>
      )}
      {!sidebar && (
        <nav className="tabs">
          {nav.tabs.map((t) => (
            <NavLink key={t.path} to={t.path} end={t.path === '/'}>
              <NavIcon name={t.icon} size={24} />
              <small>{t.tabLabel}</small>
            </NavLink>
          ))}
          {isAdult && <HornTab />}
        </nav>
      )}
    </div>
  );
}

const ProviderSignupPage = lazy(() => import('./modules/feed/Providers').then((m) => ({ default: m.ProviderSignupPage })));
const FeedLanding = lazy(() => import('./modules/social/Social').then((m) => ({ default: m.FeedLanding })));

/** The Feed's pages: open to grown-ups who joined just for the Feed (no household). */
const SOCIAL_PATHS = ['/feed', '/feed/stories', '/feed/explore', '/feed/create', '/feed/friends', '/feed/post/:id', '/feed/profile/edit', '/feed/settings', '/feed/settings/notifications', '/feed/settings/provider', '/clips', '/messages', '/messages/:id', '/people/:id', '/village', '/village/:id', '/business', '/notifications', '/search', '/invite', '/earnings', '/u/:handle'];
const SOCIAL = /^\/(feed|clips|messages|people|village|business|notifications|search|invite|earnings|u)(\/|$)/;
/** Every page that belongs to the Feed (Circles too). */
const FEED_ROUTE = /^\/(feed|clips|messages|people|village|business|circles|notifications|search|invite|earnings|u)(\/|$)/;

/**
 * The Feed's frame ("Soft Card"): warm paper, the page, and the floating dock (Home · Friends · + · Profile · Bell).
 * Light only. A conversation has its own composer at the bottom, so no dock there.
 */
function FeedShell({ profileTo, children }: { profileTo: string; children: ReactNode }) {
  useKeyboardLayout();
  const unread = useFeedUnread();
  const { pathname } = useLocation();
  useEffect(() => {
    document.body.classList.add('sc-body');
    try {
      document.documentElement.classList.toggle('sc-calm', localStorage.getItem('feed.reduceMotion') === '1');
    } catch {
      /* a convenience only */
    }
    return () => document.body.classList.remove('sc-body');
  }, []);
  const chat = /^\/messages\/[^/]+/.test(pathname);
  return (
    <div className={`${FEED_APP ? 'app social-only feed-app' : 'app social-only'} sc-app${chat ? ' no-dock' : ''}`} data-testid="social-shell">
      <OfflineBar />
      <main className="sc-main">
        <Suspense fallback={<p className="sc-meta">Loading…</p>}>{children}</Suspense>
      </main>
      {!chat && <Dock profileTo={profileTo} unread={unread} />}
    </div>
  );
}

/** A Feed-only account (or anyone in the Feed app): the social pages; MyDay is a door in Settings. */
function SocialShell() {
  return (
    <FeedShell profileTo="/me">
      <Routes>
        {MODULES.filter((m) => SOCIAL_PATHS.includes(m.path)).map((m) => (
          <Route key={m.path} path={m.path} element={m.element} />
        ))}
        <Route path="/me" element={<MyProfilePage />} />
        <Route path="*" element={<Navigate to="/feed" replace />} />
      </Routes>
    </FeedShell>
  );
}

/** Signed in with no household yet → create one (signup funnel), or the Feed for Feed-only accounts. */
function Gate() {
  const { me } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  // "Join the Feed" on the public page: land back in the Feed after signing in.
  const [next] = useState(takeNext);
  const pendingNext = !!next && location.pathname === '/' && next !== '/';
  useEffect(() => {
    if (pendingNext && next) navigate(next, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (pendingNext) return null;
  // The public page's address (conquermyday.app/thefeed): signed in, it's just the Feed.
  if (location.pathname === '/thefeed') return <Navigate to="/feed" replace />;
  // Professionals (tutors, coaches, providers) use their portal with or without a household.
  if (window.location.pathname === '/pro') return <ProPortal />;
  // Staff can open the admin dashboard without a household of their own.
  if (!me.household && me.isAdmin && (window.location.pathname === '/admin' || window.location.pathname === '/circles/moderation')) {
    return <main className="page">{window.location.pathname === '/admin' ? <Admin /> : <Moderation />}</main>;
  }
  if (!me.household) return SOCIAL.test(location.pathname) ? <SocialShell /> : <CreateHousehold />;
  return (
    <>
      <Shell />
      {me.pendingInvite && <PendingInvitePrompt household={me.pendingInvite.household} />}
    </>
  );
}

/** The standalone Feed app (its own domain): grown-ups only, the Feed and nothing else. */
function FeedApp() {
  const { me } = useSession();
  if (me.member && me.member.kind !== 'adult') {
    return (
      <main className="center" data-testid="feed-adults-only">
        <div className="card" style={{ maxWidth: 420, textAlign: 'center' }}>
          <FeedHorn tile size={64} />
          <h1>The Feed is for grown-ups</h1>
          <p className="muted">It’s an 18+ community. Your MyDay is right where you left it.</p>
          <a className="btn" href={APP_URL || '/'}>
            Open MyDay
          </a>
        </div>
      </main>
    );
  }
  return <SocialShell />;
}

export default function App() {
  const path = window.location.pathname;
  // Public pages: readable signed out.
  if (path === '/privacy') return <Privacy />;
  if (path === '/terms') return <Terms />;
  // The provider sign-up: its own path, verification before any account (signed in, it verifies this account).
  if (path === '/providers') {
    return (
      <BrowserRouter>
        <ConfirmProvider>
          <Suspense fallback={<div className="center muted">Loading…</div>}>
            <ProviderSignupPage />
          </Suspense>
        </ConfirmProvider>
      </BrowserRouter>
    );
  }
  if (FEED_APP) {
    return (
      <BrowserRouter>
        <ConfirmProvider>
          <SessionProvider
            signedOut={
              <Suspense fallback={<div className="center muted">Loading…</div>}>
                <FeedLanding />
              </Suspense>
            }
          >
            <FeedApp />
          </SessionProvider>
        </ConfirmProvider>
      </BrowserRouter>
    );
  }
  // Invite links work signed out.
  const join = path.match(/^\/join\/([^/]+)$/);
  if (join?.[1]) {
    return (
      <ConfirmProvider>
        <Join token={join[1]} />
      </ConfirmProvider>
    );
  }
  return (
    <BrowserRouter>
      <ConfirmProvider>
      <SessionProvider
        signedOut={
          path === '/feed' || path === '/thefeed' ? (
            <Suspense fallback={<div className="center muted">Loading…</div>}>
              <FeedLanding />
            </Suspense>
          ) : (
            <Login />
          )
        }
      >
        {/* The side-by-side grocery list opens in its own small window: no app chrome. */}
        {path === '/grocery-list' ? <GroceryPopout /> : <Gate />}
      </SessionProvider>
      </ConfirmProvider>
    </BrowserRouter>
  );
}
