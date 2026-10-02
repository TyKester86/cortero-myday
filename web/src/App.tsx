import { useEffect, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router';
import { api, useOffline } from './api';
import FirstRun from './components/FirstRun';
import Shortcuts from './components/Shortcuts';
import { CreateHousehold } from './Onboarding';
import { useWide } from './modules/desk/Home';
import { applyLook } from './modules/settings/Settings';
import { ConfirmProvider } from './components/Confirm';
import Join from './Join';
import Login from './Login';
import { MODULES, type ModuleRoute } from './modules';
import GroceryPopout from './modules/meals/GroceryPopout';
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

function Shell() {
  const { me, members, viewing, setViewing, isAdult } = useSession();
  const [menu, setMenu] = useState(false);
  const wide = useWide();
  useEffect(() => {
    applyLook(me.prefs?.theme ?? 'system', me.prefs?.accent ?? 'navy');
  }, [me.prefs]);
  const who: 'kid' | 'adult' = isAdult ? 'adult' : 'kid';
  const visible = (m: ModuleRoute): boolean =>
    m.audience === 'all' ||
    m.audience === who ||
    (m.audience === 'tutor' && (who === 'kid' || me.xpTrack === 'student'));
  const routes = MODULES.filter(visible);
  const tabs = routes.filter((m) => m.nav?.tabFor?.includes(who));
  const menuItems = routes.filter((m) => m.nav && !m.nav.tabFor?.includes(who));
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
  return (
    <div className={wide && isAdult ? 'app wide' : 'app'}>
      <OfflineBar />
      <header className="top">
        <img src="/icons/myday-mark.svg" alt="" className="mark" />
        <b>MyDay</b>
        {isAdult && members.length > 1 ? (
          <select aria-label="Whose day" value={viewing?.key ?? ''} onChange={(e) => setViewing(e.target.value)}>
            {members.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="who">{me.member?.name ?? me.name}</span>
        )}
        <button className="link light" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          ☰
        </button>
        {menu && (
          <nav className="menu" onClick={() => setMenu(false)}>
            {menuItems.map((m) => (
              <Link key={m.path} to={m.path}>
                {m.nav?.icon} {m.nav?.label}
              </Link>
            ))}
            <button className="link" onClick={() => void signOut()}>
              Sign out
            </button>
          </nav>
        )}
      </header>
      <main>
        <Routes>
          {routes.map((m) => (
            <Route key={m.path} path={m.path} element={m.element} />
          ))}
          <Route path="*" element={<p className="muted">Page not found.</p>} />
        </Routes>
      </main>
      <FirstRun />
      <Shortcuts enabled={wide} />
      <nav className="tabs">
        {tabs.map((m) => (
          <NavLink key={m.path} to={m.path} end={m.path === '/'}>
            <span>{m.nav?.icon}</span>
            <small>{m.nav?.label}</small>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** Signed in with no household yet → create one (signup funnel). */
function Gate() {
  const { me } = useSession();
  if (!me.household) return <CreateHousehold />;
  return <Shell />;
}

export default function App() {
  const path = window.location.pathname;
  // Invite links work signed out.
  const join = path.match(/^\/join\/([^/]+)$/);
  if (join?.[1]) return <Join token={join[1]} />;
  return (
    <BrowserRouter>
      <ConfirmProvider>
      <SessionProvider signedOut={<Login />}>
        {/* The side-by-side grocery list opens in its own small window: no app chrome. */}
        {path === '/grocery-list' ? <GroceryPopout /> : <Gate />}
      </SessionProvider>
      </ConfirmProvider>
    </BrowserRouter>
  );
}
