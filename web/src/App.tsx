import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import type { ModuleKey } from '@myday/shared';
import { api, useOffline } from './api';
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
import { MODULES } from './modules';
import { SocialHeader, takeNext } from './modules/social/shell';
import { HanaFace, NavIcon } from './components/NavIcon';
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

function Shell() {
  const { me, viewable, viewing, setViewing, isAdult } = useSession();
  const [menu, setMenu] = useState(false);
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
  // Grown-ups on a desktop get a sidebar instead of the phone's bottom bar + menu.
  const sidebar = wide && isAdult;
  const signOut = async (): Promise<void> => {
    await api('/api/auth/logout', 'POST');
    // Don't leave this person's cached data on a shared device.
    navigator.serviceWorker?.controller?.postMessage('clear-api');
    try {
      localStorage.removeItem('myday.offline-queue');
    } catch {
      /* ignore */
    }
    window.location.href = '/';
  };
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
  return (
    <div className={sidebar ? 'app wide sidebar' : 'app'}>
      <OfflineBar />
      <header className="top">
        <img src="/icons/myday-mark.svg" alt="" className="mark" />
        <b>MyDay</b>
        {isAdult && viewable.length > 1 ? (
          <select aria-label="Whose day" value={viewing?.key ?? ''} onChange={(e) => setViewing(e.target.value)}>
            {viewable.map((m) => (
              <option key={m.key} value={m.key}>
                {m.key === me.member?.key ? `${m.name} (me)` : m.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="who">{me.member?.name ?? me.name}</span>
        )}
        {!sidebar && (
          <button className="link light" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            ☰
          </button>
        )}
        {menu && !sidebar && (
          <nav className="menu" data-testid="menu">
            {groupedLinks(() => setMenu(false))}
            <button className="link" onClick={() => void signOut()}>
              Sign out
            </button>
          </nav>
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
        </nav>
      )}
    </div>
  );
}

const FeedLanding = lazy(() => import('./modules/social/Social').then((m) => ({ default: m.FeedLanding })));

/** The Feed's pages: open to grown-ups who joined just for the Feed (no household). */
const SOCIAL_PATHS = ['/feed', '/feed/stories', '/clips', '/messages', '/messages/:id', '/people/:id', '/village', '/village/:id'];
const SOCIAL = /^\/(feed|clips|messages|people|village)(\/|$)/;

/** A Feed-only account: the social pages, with a way to set up the rest of MyDay later. */
function SocialShell() {
  useKeyboardLayout();
  useEffect(() => {
    applyLook('system', 'navy');
  }, []);
  return (
    <div className="app social-only">
      <SocialHeader />
      <main>
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Routes>
            {MODULES.filter((m) => SOCIAL_PATHS.includes(m.path)).map((m) => (
              <Route key={m.path} path={m.path} element={m.element} />
            ))}
            <Route path="*" element={<Navigate to="/feed" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
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

export default function App() {
  const path = window.location.pathname;
  // Public pages: readable signed out.
  if (path === '/privacy') return <Privacy />;
  if (path === '/terms') return <Terms />;
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
          path === '/feed' ? (
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
