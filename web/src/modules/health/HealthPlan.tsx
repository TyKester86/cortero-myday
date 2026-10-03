import { Link } from 'react-router';
import type { HealthPlan as HealthPlanData } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { useSession } from '../../session';
import { day } from '../../dates';

/** All 52 phased weeks, the current one highlighted, then each phase in detail. */
export default function HealthPlan() {
  const { viewing } = useSession();
  const { data, error, reload } = useLoad<HealthPlanData>(viewing ? withMember('/api/workouts/plan', viewing.key) : null);
  const confirm = useConfirm();
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.hasPlan) {
    return (
      <section>
        <h1>The year plan</h1>
        <p className="muted">No plan loaded for {data.member.name} yet.</p>
        <Link className="btn" to="/health">
          Pick a build to plan the year
        </Link>
      </section>
    );
  }
  return (
    <section>
      <h1>The year plan</h1>
      <p className="muted">
        You're in week {data.currentWeek} of 52 · <Link to="/health">Today</Link>
      </p>
      <div className="row small" data-testid="chapters">
        {data.chapters.map((c) => {
          const now = data.currentWeek >= c.weekStart && data.currentWeek <= c.weekEnd;
          return (
            <span key={c.n} className={now ? 'pill sun' : 'pill'}>
              {c.title}
              {!now && viewing && (
                <button
                  className="link"
                  onClick={() =>
                    void (async () => {
                      if (!(await confirm({ title: `Start ${c.title.split(' · ')[0]} this week?`, body: `Week ${c.weekStart} becomes this week. Nothing you’ve logged is lost.`, confirmLabel: 'Start here' }))) return;
                      await api(withMember('/api/program/restart', viewing.key), 'POST', { chapter: c.n });
                      reload();
                    })()
                  }
                >
                  {' '}start here
                </button>
              )}
            </span>
          );
        })}
      </div>
      <div className="weeks" data-testid="plan-weeks">
        {data.weeks.map((w) => (
          <div
            key={w.week}
            className={[
              'wk',
              `wk-${w.kind ?? 'none'}`,
              w.isCurrent ? 'current' : '',
              w.kind === 'deload' ? 'deload' : '',
              w.week < data.currentWeek ? 'past' : '',
            ].join(' ')}
            title={`${w.phase ?? 'Unplanned'} · starts ${day(w.starts)}`}
            aria-current={w.isCurrent ? 'true' : undefined}
          >
            <b>{w.week}</b>
            {w.kind === 'deload' ? 'deload' : (w.kind ?? '—')}
          </div>
        ))}
      </div>
      {data.phases.map((p) => {
        const now = data.currentWeek >= p.weekStart && data.currentWeek <= p.weekEnd;
        return (
          <div key={p.id} className={now ? 'card current' : 'card'}>
            <h2>
              {p.name} <span className="muted">· weeks {p.weekStart}–{p.weekEnd}</span>
              {now && <span className="tag">NOW</span>}
            </h2>
            {p.focus && <p>{p.focus}</p>}
            {p.nutrition && <p className="small">Eating: {p.nutrition}</p>}
            {p.cardio && <p className="small">Cardio: {p.cardio}</p>}
            <small className="muted">{p.days.join(' · ')}</small>
          </div>
        );
      })}
    </section>
  );
}
