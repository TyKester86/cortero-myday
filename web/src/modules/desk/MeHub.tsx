import { Link } from 'react-router';
import { useSession } from '../../session';
import { navFor } from '../nav';
import { NavIcon } from '../../components/NavIcon';
import { signOut } from '../../signout';

/** Everything in one calm, grouped place (the phone's "Me" tab): you, then every page as a row. */
export default function MeHub() {
  const { me } = useSession();
  const nav = navFor(me);
  const name = me.member?.name ?? me.name;
  const role = [me.member?.kind === 'adult' ? (me.household?.hasKids ? 'Parent' : 'Grown-up') : 'Kid', me.household?.name].filter(Boolean).join(' • ');
  return (
    <section data-testid="me-hub" className="me">
      <header className="page-head centered">
        <h1 className="page-title">Me</h1>
      </header>
      <Link to="/settings" className="card me-card" data-testid="me-card">
        <span className="ring-avatar" style={{ width: 112, height: 112, fontSize: 46 }} aria-hidden="true">
          {name.slice(0, 1)}
        </span>
        <span>
          <b className="me-name">{name}</b>
          <span className="me-role" style={{ display: 'block' }}>
            {role}
          </span>
        </span>
      </Link>
      {nav.groups
        .map((g) => ({ ...g, items: g.items.filter((i) => i.path !== '/me') }))
        .filter((g) => g.key !== 'today' && g.items.length > 0)
        .map((g) => (
          <div key={g.key} className="hubgroup">
            <h2 className="eyebrow">{g.label}</h2>
            <div className="row-list">
              {g.items.map((i) => (
                <Link key={i.path} to={i.path} className="row-card hubtile">
                  <span className="row-icon">
                    <NavIcon name={i.icon} size={28} />
                  </span>
                  <b className="row-title">{i.label}</b>
                  <span className="row-chev">
                    <NavIcon name="chevron" />
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      {me.member?.kind === 'adult' && (
        <p className="small muted">
          Missing something? Turn parts of MyDay on or off in <Link to="/settings">Settings</Link>.
        </p>
      )}
      <button type="button" className="btn ghost signout" onClick={() => void signOut()} data-testid="sign-out">
        Sign out
      </button>
    </section>
  );
}
