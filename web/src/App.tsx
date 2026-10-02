import { useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router';
import { api } from './api';
import Login from './Login';
import { MODULES } from './modules';
import { SessionProvider, useSession } from './session';

function Shell() {
  const { me, members, viewing, setViewing, isAdult } = useSession();
  const [menu, setMenu] = useState(false);
  const routes = MODULES.filter((m) => !m.adultOnly || isAdult);
  const signOut = async (): Promise<void> => {
    await api('/api/auth/logout', 'POST');
    window.location.href = '/';
  };
  return (
    <div className="app">
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
            {routes
              .filter((m) => m.nav?.place === 'menu')
              .map((m) => (
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
      <nav className="tabs">
        {routes
          .filter((m) => m.nav?.place === 'tab')
          .map((m) => (
            <NavLink key={m.path} to={m.path} end={m.path === '/'}>
              <span>{m.nav?.icon}</span>
              <small>{m.nav?.label}</small>
            </NavLink>
          ))}
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider signedOut={<Login />}>
        <Shell />
      </SessionProvider>
    </BrowserRouter>
  );
}
