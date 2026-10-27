import { Link } from 'react-router';
import type { HanaCoach } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { HanaFace } from '../../components/NavIcon';

const STEP_BUTTON: string[] = ['I started', 'Did a chunk', 'Ready to hand in'];

/** Four dots: not started → started → most of the way → ready. */
function Progress({ step }: { step: number }) {
  return (
    <span className="coach-dots" aria-label={`Step ${step} of 3`} data-testid="coach-progress">
      {[1, 2, 3].map((n) => (
        <span key={n} className={n <= step ? 'dot on' : 'dot'} />
      ))}
    </span>
  );
}

/**
 * Hana's homework plan: ONE next action, a short horizon, wins first. Never a wall of
 * overdue red — anything past its date is just "still open".
 */
export function CoachCard({ memberKey = null }: { memberKey?: string | null }) {
  const path = memberKey ? withMember('/api/hana/coach', memberKey) : '/api/hana/coach';
  const { data, reload } = useLoad<HanaCoach>(path);
  if (!data) return null;
  const f = data.focus;
  const step = async (n: number): Promise<void> => {
    if (!f) return;
    await api(`/api/hana/coach/${f.homeworkId}/step`, 'POST', { step: n });
    reload();
  };
  const notNow = async (): Promise<void> => {
    if (!data.nudge) return;
    await api(`/api/hana/nudges/${data.nudge.homeworkId}/dismiss`, 'POST', {});
    reload();
  };
  return (
    <div className="card coach" data-testid="hana-coach">
      <div className="hana-brief-head">
        <HanaFace size={32} />
        <b>{memberKey ? `${data.member.name}’s plan` : 'Hana’s plan for you'}</b>
      </div>
      {data.celebrate.map((c) => (
        <p key={c} className="coach-win" data-testid="coach-win">
          🎉 {c}
        </p>
      ))}
      {data.nudge && (
        <p className="coach-nudge" data-testid="coach-nudge">
          {data.nudge.text}{' '}
          <button type="button" className="link" onClick={() => void notNow()} data-testid="coach-not-now">
            Not now
          </button>
        </p>
      )}
      {f ? (
        <div className="coach-focus" data-testid="coach-focus">
          <small className="muted">{f.when}</small>
          <p className="coach-next">{f.nextAction}</p>
          <Progress step={f.step} />
          {f.check && <small className="hana-check">Check: {f.check}</small>}
          {f.step < 3 ? (
            <button type="button" className="btn" onClick={() => void step(f.step + 1)} data-testid="coach-step">
              {STEP_BUTTON[f.step]}
            </button>
          ) : (
            <Link to="/homework" className="btn">
              Check it off in Homework
            </Link>
          )}
        </div>
      ) : (
        <p className="muted">No homework with a due date right now.</p>
      )}
      {data.upcoming.length > 0 && (
        <ul className="coach-later" data-testid="coach-upcoming">
          {data.upcoming.map((p) => (
            <li key={p.homeworkId}>
              {p.assignment} <small className="muted">· {p.when}</small>
            </li>
          ))}
        </ul>
      )}
      {data.moreLater > 0 && <small className="muted">+{data.moreLater} more later — one thing at a time.</small>}
      {data.chores && (data.chores.total > 0 || data.chores.reward) && (
        <p className="small" data-testid="coach-chores">
          {data.chores.total ? `${data.chores.done} of ${data.chores.total} chores done` : 'No chores today'} · {data.chores.points} points
          {data.chores.reward ? ` · ${data.chores.reward.short ? `${data.chores.reward.short} points from ${data.chores.reward.name}` : `${data.chores.reward.name} is within reach`}` : ''}
        </p>
      )}
    </div>
  );
}
