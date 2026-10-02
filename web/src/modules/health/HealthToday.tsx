import { useState } from 'react';
import { Link } from 'react-router';
import type { CompleteDayResponse, HealthToday as HealthTodayData, LogExerciseRequest, WorkoutExercise } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useSession } from '../../session';

function LogRow({ ex, onLog }: { ex: WorkoutExercise; onLog: (r: LogExerciseRequest) => Promise<void> }) {
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <div className="logrow">
      <input placeholder="weight" value={weight} onChange={(e) => setWeight(e.target.value)} />
      <input placeholder="reps" value={reps} onChange={(e) => setReps(e.target.value)} />
      <button
        className="btn small"
        onClick={() =>
          void onLog({ exercise: ex.exercise, sets: ex.sets, reps, weight, phaseName: '', dayName: '' }).then(() =>
            setSaved(true),
          )
        }
      >
        {saved ? 'Logged ✓' : 'Log'}
      </button>
    </div>
  );
}

export default function HealthToday() {
  const { viewing } = useSession();
  const path = viewing ? withMember('/api/workouts/today', viewing.key) : null;
  const { data, error, reload } = useLoad<HealthTodayData>(path);
  const [msg, setMsg] = useState<string | null>(null);

  if (error) return <p className="error">{error}</p>;
  if (!data || !viewing) return <p className="muted">Loading…</p>;

  const log = async (r: LogExerciseRequest): Promise<void> => {
    await api(withMember('/api/workouts/log', viewing.key), 'POST', {
      ...r,
      phaseName: data.phaseName,
      dayName: data.session?.dayName ?? '',
    });
  };
  const complete = async (): Promise<void> => {
    const r = await api<CompleteDayResponse>(withMember('/api/workouts/complete-day', viewing.key), 'POST');
    setMsg(r.choreMarked ? 'Workout done — chore checked off ✓' : 'Workout done ✓');
    reload();
  };

  return (
    <section>
      <h1>Today's workout</h1>
      <p className="muted">
        Week {data.weekNum}
        {data.phaseName && ` · ${data.phaseName}`}
        {data.focus && ` · ${data.focus}`} · <Link to="/health/plan">Year plan</Link>
      </p>

      {data.isRest || !data.session ? (
        <div className="card" data-testid="rest-day">
          <h2>Rest / cardio day</h2>
          <p>{data.profile?.cardio || 'Recovery day. Walk, stretch, hydrate.'}</p>
        </div>
      ) : (
        <>
          <h2 data-testid="session-name">
            Day {data.session.dayNum}: {data.session.dayName}
          </h2>
          {data.session.exercises.map((ex) => {
            const last = data.last[ex.exercise];
            return (
              <div className="card exercise" key={ex.exercise}>
                <div className="ex-head">
                  <b>{ex.exercise}</b>
                  <span>
                    {ex.sets} × {ex.reps}
                    {ex.rest && ` · rest ${ex.rest}`}
                  </span>
                </div>
                {ex.equipment && <small className="muted">{ex.equipment}</small>}
                {ex.cues && <p className="cues">{ex.cues}</p>}
                {ex.subs && <small className="muted">Swap: {ex.subs}</small>}
                {last && (
                  <small className="muted">
                    Last: {last.weight} × {last.reps} ({last.date})
                  </small>
                )}
                <LogRow ex={ex} onLog={log} />
              </div>
            );
          })}
          <button className="btn" disabled={data.dayCompleted} onClick={() => void complete()}>
            {data.dayCompleted ? 'Done today ✓' : 'Complete workout'}
          </button>
        </>
      )}
      {msg && <p className="muted">{msg}</p>}

      {data.profile && (
        <div className="card">
          <h2>Fuel</h2>
          <p>
            {data.profile.targetCalories} cal · {data.profile.targetProtein}g protein · {data.profile.targetCarbs}g carbs ·{' '}
            {data.profile.targetFat}g fat
          </p>
          {data.profile.breakfast && <p>Breakfast: {data.profile.breakfast}</p>}
          {data.profile.shake && <p>Shake: {data.profile.shake}</p>}
        </div>
      )}
    </section>
  );
}
