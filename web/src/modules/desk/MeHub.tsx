import { Link } from 'react-router';
import { useSession } from '../../session';
import { navFor } from '../nav';
import { NavIcon } from '../../components/NavIcon';

/** Everything in one calm, grouped place (the phone's "Me" tab). */
export default function MeHub() {
  const { me } = useSession();
  const nav = navFor(me);
  return (
    <section data-testid="me-hub">
      <h1>Hi, {me.member?.name ?? me.name}</h1>
      {nav.groups
        .filter((g) => g.key !== 'today')
        .map((g) => (
          <div key={g.key} className="hubgroup">
            <h2>{g.label}</h2>
            <div className="hubtiles">
              {g.items.map((i) => (
                <Link key={i.path} to={i.path} className="hubtile">
                  <NavIcon name={i.icon} size={28} />
                  {i.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      <p className="small muted">
        Missing something? Turn parts of MyDay on or off in <Link to="/settings">Settings</Link>.
      </p>
    </section>
  );
}
