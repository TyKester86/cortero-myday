import { useState } from 'react';
import { Link } from 'react-router';
import {
  HABITS,
  type CompleteDayResponse,
  type HabitKey,
  type HealthHistory,
  type HealthToday as HealthTodayData,
  type LogExerciseRequest,
  type ProgramStatus,
  type ToggleHabitResponse,
  type WorkoutExercise,
} from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useToast } from '../../components/useToast';
import { useSession } from '../../session';
import { BuildPicker, ProgramCard } from './Program';
import { ProgressPhotos } from './ProgressPhotos';
import { day } from '../../dates';

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

/** A4: log any workout (a walk, a game, a class) and keep the baseline notes. */
function Records({ memberKey }: { memberKey: string }) {
  const { data, setData } = useLoad<HealthHistory>(withMember('/api/workouts/history', memberKey));
  const [activity, setActivity] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [miles, setMiles] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return null;
  const logSession = async (): Promise<void> => {
    try {
      const r = await api<{ runWarning: string | null }>(withMember('/api/workouts/session', memberKey), 'POST', {
        activity: activity || 'Workout',
        minutes: Number(minutes) || 20,
        ...(miles ? { miles: Number(miles) } : {}),
      });
      setData(await api<HealthHistory>(withMember('/api/workouts/history', memberKey)));
      setActivity('');
      setMiles('');
      setMsg(r.runWarning ?? 'Logged ✓');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const saveBaseline = async (b: HealthHistory['baseline']): Promise<void> => {
    try {
      setData(await api<HealthHistory>(withMember('/api/workouts/baseline', memberKey), 'PUT', b));
      setMsg('Baseline saved ✓');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  return (
    <>
      <div className="card" data-testid="session-log">
        <h2>Log any workout</h2>
        <p className="muted small">{data.weekMinutes} active minutes in the last 7 days.</p>
        <div className="inline">
          <input placeholder="What did you do? (walk, soccer…)" value={activity} onChange={(e) => setActivity(e.target.value)} maxLength={40} />
          <input className="qty" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, '').slice(0, 3))} aria-label="Minutes" />
          <input className="qty" inputMode="decimal" value={miles} onChange={(e) => setMiles(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))} placeholder="mi" aria-label="Miles (optional)" />
          <button className="btn small" onClick={() => void logSession()}>
            Log
          </button>
        </div>
        {data.sessions.length > 0 && (
          <ul className="plain small">
            {data.sessions.slice(0, 6).map((s, i) => (
              <li key={i}>
                {day(s.date)} · {s.activity} · {s.minutes} min{s.miles ? ` · ${s.miles} mi` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="card">
        <summary>
          <b>Baseline notes</b> <span className="muted small">where you started</span>
        </summary>
        <BaselineForm initial={data.baseline} onSave={(b) => void saveBaseline(b)} />
        {data.exercises.length > 0 && (
          <>
            <h2>Recent lifts</h2>
            <ul className="plain small">
              {data.exercises.slice(0, 12).map((x, i) => (
                <li key={i}>
                  {day(x.date)} · {x.exercise} {x.weight && `· ${x.weight}`} {x.reps && `× ${x.reps}`}
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
      {msg && <p className="muted small">{msg}</p>}
    </>
  );
}

function BaselineForm({ initial, onSave }: { initial: HealthHistory['baseline']; onSave: (b: HealthHistory['baseline']) => void }) {
  const [b, setB] = useState(initial);
  return (
    <div className="form">
      <label>
        Exercise right now
        <input value={b.exercise} maxLength={100} onChange={(e) => setB({ ...b, exercise: e.target.value })} />
      </label>
      <label>
        Sleep
        <input value={b.sleep} maxLength={40} onChange={(e) => setB({ ...b, sleep: e.target.value })} />
      </label>
      <label>
        Food
        <input value={b.food} maxLength={100} onChange={(e) => setB({ ...b, food: e.target.value })} />
      </label>
      <button className="btn small" onClick={() => onSave(b)}>
        Save baseline
      </button>
    </div>
  );
}

export default function HealthToday() {
  const { viewing, me } = useSession();
  const path = viewing ? withMember('/api/workouts/today', viewing.key) : null;
  const { data, error, reload, setData } = useLoad<HealthTodayData>(path);
  const [msg, setMsg] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const { toast, earned } = useToast();

  if (error) return <p className="error">{error}</p>;
  if (!data || !viewing) return <p className="muted">Loading…</p>;

  const log = async (r: LogExerciseRequest): Promise<void> => {
    await api(withMember('/api/workouts/log', viewing.key), 'POST', {
      ...r,
      phaseName: data.phaseName,
      dayName: data.session?.dayName ?? '',
    });
  };
  const toggleHabit = async (key: HabitKey, done: boolean): Promise<void> => {
    const r = await api<ToggleHabitResponse>(withMember(`/api/habits/${key}`, viewing.key), 'POST', { done });
    setData({ ...data, habits: r.habits });
    if (done) earned(r, HABITS.find((h) => h.key === key)?.points ?? 0);
  };
  const complete = async (): Promise<void> => {
    const r = await api<CompleteDayResponse>(withMember('/api/workouts/complete-day', viewing.key), 'POST');
    setMsg(r.choreMarked ? 'Workout done — chore checked off ✓' : 'Workout done ✓');
    reload();
  };
  const moveTomorrow = async (): Promise<void> => {
    try {
      await api(withMember('/api/workouts/move', viewing.key), 'POST', { to: 'tomorrow' });
      setMsg('Moved to tomorrow — no stress.');
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not move it');
    }
  };
  const picked = (_p: ProgramStatus | null): void => {
    setPicking(false);
    reload();
  };
  const teen = data.member.kind === 'kid' || (data.member.age !== null && data.member.age < 18);
  // Progress photos are private: only on your own page, and never in teen mode.
  const photos = !teen && me.member?.key === viewing.key ? <ProgressPhotos today={data.date} /> : null;
  const restartPhase = async (): Promise<void> => {
    await api(withMember('/api/program/restart', viewing.key), 'POST', {});
    setMsg('Restarted this phase — welcome back.');
    reload();
  };

  const habits = (
    <div className="card" data-testid="habits">
      <h2>Daily habits</h2>
      <div className="habits">
        {HABITS.filter((h) => data.habitKeys.includes(h.key)).map((h) => (
          <label key={h.key} className={data.habits[h.key] ? 'habit on' : 'habit'}>
            <input type="checkbox" checked={data.habits[h.key]} onChange={(e) => void toggleHabit(h.key, e.target.checked)} />
            {h.label}
            <small>+{h.points}</small>
          </label>
        ))}
      </div>
    </div>
  );

  // No plan yet: never a made-up workout — pick a build and the year is planned.
  if (!data.hasPlan || picking) {
    return (
      <section>
        <h1>{picking ? 'Change your build' : 'Plan your year'}</h1>
        <p className="muted">
          {teen
            ? 'Pick a training style. MyDay plans all 52 weeks of training — what your body can do is the goal.'
            : 'Pick the look you’re going for. MyDay plans all 52 weeks — phases, sets and food — and keeps it safe.'}
        </p>
        <BuildPicker memberKey={viewing.key} current={data.program} onDone={picked} teen={teen} age={data.member.age} />
        {picking && (
          <button className="link" onClick={() => setPicking(false)}>
            Cancel
          </button>
        )}
        {habits}
        {photos}
        <Records memberKey={viewing.key} />
        {toast}
      </section>
    );
  }

  return (
    <section>
      <h1>Today's workout</h1>
      <p className="muted">
        Week {data.weekNum}
        {data.phaseName && ` · ${data.phaseName}`}
        {data.focus && ` · ${data.focus}`} · <Link to="/health/plan">Year plan</Link>
      </p>

      {data.program && (
        <ProgramCard program={data.program} onChange={() => setPicking(true)} memberKey={viewing.key} onUpdate={(program) => setData({ ...data, program })} />
      )}
      {data.onboarding && (
        <div className="card" data-testid="onboarding">
          <b>Day {data.onboarding.day} of your first 28 days.</b> {data.onboarding.attended} session{data.onboarding.attended === 1 ? '' : 's'} so far — showing up is the whole goal this month.
        </div>
      )}
      {data.comeback && (
        <div className="card" data-testid="comeback">
          {data.comeback.message}{' '}
          {data.comeback.mode === 'restart' && (
            <button className="btn small" onClick={() => void restartPhase()}>
              Restart this phase
            </button>
          )}
        </div>
      )}
      <p className="small" data-testid="week-progress">
        This week: {data.week.done} of {data.week.planned} sessions
        {data.week.minimumMet ? ' · minimum week done ✓ — two sessions counts as a win' : ' · two sessions counts as a win'}
      </p>
      {data.runCap && (
        <p className="small muted" data-testid="run-cap">
          {data.runCap.capMinutes
            ? `Longest run in the last 30 days: ${data.runCap.longestMinutes} min${data.runCap.longestMiles ? ` / ${data.runCap.longestMiles} mi` : ''}. Keep any single run under ${data.runCap.capMinutes} min${data.runCap.capMiles ? ` / ${data.runCap.capMiles} mi` : ''}.`
            : 'Log your runs (minutes, and miles if you know them): no single run should be more than 10% longer than your longest in the last 30 days.'}
        </p>
      )}
      {habits}

      {data.moved?.to && (
        <div className="card" data-testid="moved">
          Today's session moved to <b>{data.moved.to}</b>. Enjoy the rest.
        </div>
      )}
      {data.isRest || !data.session ? (
        <div className="card" data-testid="rest-day">
          <h2>Rest / cardio day</h2>
          <p>{data.program?.cardio || data.profile?.cardio || 'Recovery day. Walk, stretch, hydrate.'}</p>
        </div>
      ) : (
        <>
          <h2 data-testid="session-name">
            Day {data.session.dayNum}: {data.session.dayName}
            {data.moved?.from && <span className="muted small"> · moved from {data.moved.from}</span>}
          </h2>
          {data.session.exercises.map((ex) => {
            const last = data.last[ex.exercise];
            return (
              <div className="card exercise" key={ex.exercise}>
                {ex.image && <img className="exdemo" src={ex.image} alt={`${ex.exercise} demonstration`} loading="lazy" data-testid="exercise-demo" />}
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
                    Last: {last.weight} × {last.reps} ({day(last.date)})
                  </small>
                )}
                {ex.next && (
                  <small className="next" data-testid="next-step">
                    Next: {ex.next}
                  </small>
                )}
                <LogRow ex={ex} onLog={log} />
              </div>
            );
          })}
          <div className="row">
            <button className="btn" disabled={data.dayCompleted} onClick={() => void complete()}>
              {data.dayCompleted ? 'Done today ✓' : 'Complete workout'}
            </button>
            {!data.dayCompleted && (
              <button className="btn ghost" onClick={() => void moveTomorrow()}>
                Move to tomorrow
              </button>
            )}
          </div>
        </>
      )}
      {msg && <p className="muted">{msg}</p>}

      {data.profile && !data.program && (
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
      {photos}
      <Records memberKey={viewing.key} />
      {toast}
    </section>
  );
}
