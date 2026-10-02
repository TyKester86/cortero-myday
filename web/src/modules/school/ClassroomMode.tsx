import { Link } from 'react-router';
import type { SchoolResponse } from '@myday/shared';
import { useLoad } from '../../api';
import { useSession } from '../../session';

/**
 * Classroom Mode: just today's classes and the recorder. Grown-ups get the
 * honest note about locking a phone down during class.
 */
export default function ClassroomMode() {
  const { isAdult } = useSession();
  const { data, error } = useLoad<SchoolResponse>('/api/school');
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const list = data.todayClasses.length ? data.todayClasses : data.classes;
  return (
    <section data-testid="classroom-mode">
      <h1>Classroom mode</h1>
      <p className="muted">{data.todayClasses.length ? 'Your classes today.' : 'No classes scheduled today — here are all of them.'}</p>
      <ul className="plain rows">
        {list.map((c) => (
          <li key={c.id}>
            <span>
              <b>{c.name}</b> <small className="muted">{[c.startTime, c.room].filter(Boolean).join(' · ')}</small>
            </span>
            <Link className="btn small" to={`/record?class=${c.id}`}>
              Record
            </Link>
          </li>
        ))}
      </ul>

      <div className="card" data-testid="guided-access">
        <h2>{isAdult ? 'For parents: keeping the phone on just this' : 'Staying focused in class'}</h2>
        <p>
          <b>Plainly: a web app can't lock a phone.</b> MyDay can't stop someone switching apps, and it doesn't try to. The phone itself can:
        </p>
        <ul>
          <li>
            <b>iPhone — Guided Access</b> (locks the phone to one app): Settings → Accessibility → Guided Access → On, set a passcode. Open
            MyDay, triple-click the side button, tap Start. Triple-click and enter the passcode to end it.
          </li>
          <li>
            <b>iPhone — Screen Time</b> (parent-managed): Settings → Screen Time → Downtime or App Limits during school hours, with MyDay
            under "Always Allowed".
          </li>
          <li>
            <b>Android</b>: Settings → Security → App pinning (screen pinning), or Google Family Link school-time schedules.
          </li>
        </ul>
        <p className="muted small">Recording a class also needs the teacher's OK — check the school's policy.</p>
      </div>
    </section>
  );
}
