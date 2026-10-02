import { Link } from 'react-router';
import type { HealthPlan as HealthPlanData } from '@myday/shared';
import { useLoad, withMember } from '../../api';
import { useSession } from '../../session';

export default function HealthPlan() {
  const { viewing } = useSession();
  const { data, error } = useLoad<HealthPlanData>(viewing ? withMember('/api/workouts/plan', viewing.key) : null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <section>
      <h1>The year plan</h1>
      <p className="muted">
        You're in week {data.currentWeek} of 52 · <Link to="/health">Today</Link>
      </p>
      {data.phases.length === 0 && <p className="muted">No plan loaded for {data.member.name} yet.</p>}
      {data.phases.map((p) => {
        const now = data.currentWeek >= p.weekStart && data.currentWeek <= p.weekEnd;
        return (
          <div key={p.id} className={now ? 'card current' : 'card'}>
            <h2>
              {p.name} <span className="muted">· weeks {p.weekStart}–{p.weekEnd}</span>
              {now && <span className="tag">NOW</span>}
            </h2>
            {p.focus && <p>{p.focus}</p>}
            <small className="muted">{p.days.join(' · ')}</small>
          </div>
        );
      })}
    </section>
  );
}
