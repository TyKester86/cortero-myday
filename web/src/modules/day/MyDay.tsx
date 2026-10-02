import { useState, type FormEvent } from 'react';
import {
  CONTEXTS,
  END_ENERGY,
  ENERGIES,
  NERVOUS,
  PRIORITIES,
  SLEEP,
  WEEKDAYS,
  type Checkin,
  type EarnResult,
  type Energy,
  type MyDayResponse,
  type NewTask,
  type Priority,
  type Review,
} from '@myday/shared';
import { api, useLoad } from '../../api';
import QuickNote from '../../components/QuickNote';
import { XpBar } from '../../components/XpBar';
import { useToast } from '../../components/useToast';

type EarnDay = EarnResult & { day: MyDayResponse };

function Chips<T extends string>({ options, value, onPick }: { options: readonly T[]; value: string; onPick: (v: T) => void }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button type="button" key={o} className={value === o ? 'chip on' : 'chip'} onClick={() => onPick(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

const EMPTY_CHECKIN: Checkin = { nervous: '', sleep: '', fuel: '', grateful: '' };
const EMPTY_REVIEW: Review = { got: '', derailed: '', tomorrow: '', rsd: '', energyEnd: '' };

/** The grown-up's day: morning check-in, energy-tagged tasks, habits, evening review. */
export default function MyDay() {
  const { data, error, setData } = useLoad<MyDayResponse>('/api/day');
  const { toast, show, earned } = useToast();
  const [ci, setCi] = useState<Checkin | null>(null);
  const [rv, setRv] = useState<Review | null>(null);
  const [task, setTask] = useState<NewTask>({ task: '', priority: 'Important', energy: 'Low Brain', context: '', estMin: null, mit: false });
  const [habit, setHabit] = useState('');

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const checkin = ci ?? data.checkin ?? EMPTY_CHECKIN;
  const review = rv ?? data.review ?? EMPTY_REVIEW;

  const earn = async (p: Promise<EarnDay>, xpMsg: string): Promise<void> => {
    try {
      const r = await p;
      const gained = r.xp.total - data.xp.total;
      setData(r.day);
      if (r.leveledUp) earned(r, 0);
      else show(gained > 0 ? `+${gained} XP · ${xpMsg}` : xpMsg);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const addTask = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setData(await api<MyDayResponse>('/api/day/tasks', 'POST', task));
    setTask({ ...task, task: '', mit: false });
  };

  return (
    <section>
      <h1>My day</h1>
      <QuickNote />
      <XpBar xp={data.xp} />
      <div className="card">
        <div className="ex-head">
          <h2>Today's score</h2>
          <b data-testid="daily-total">{data.daily.total}/100</b>
        </div>
        <ul className="plain rows">
          {data.daily.labels.map((l, i) => (
            <li key={l}>
              <span>{l}</span>
              <span>{(data.daily.parts[i] ?? 0) > 0 ? '✓ 20' : '—'}</span>
            </li>
          ))}
        </ul>
      </div>

      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          void earn(api<EarnDay>('/api/day/checkin', 'PUT', checkin), 'Checked in');
          setCi(null);
        }}
      >
        <h2>🌅 Morning check-in {data.checkin && <small className="muted">· saved</small>}</h2>
        <small className="muted">Nervous system</small>
        <Chips options={NERVOUS} value={checkin.nervous} onPick={(v) => setCi({ ...checkin, nervous: v })} />
        <small className="muted">Sleep</small>
        <Chips options={SLEEP} value={checkin.sleep} onPick={(v) => setCi({ ...checkin, sleep: v })} />
        <label>
          Fuel
          <input value={checkin.fuel} onChange={(e) => setCi({ ...checkin, fuel: e.target.value })} placeholder="Breakfast, water, meds…" />
        </label>
        <label>
          Grateful for
          <input value={checkin.grateful} onChange={(e) => setCi({ ...checkin, grateful: e.target.value })} />
        </label>
        <button className="btn">{data.checkin ? 'Update check-in' : 'Check in'}</button>
      </form>

      <div className="card">
        <h2>✅ Tasks</h2>
        {data.energyNote && (
          <p className="small muted" data-testid="energy-note">
            {data.energyNote}
          </p>
        )}
        {data.tasks.length === 0 && <p className="muted">No tasks yet. Pick the one thing that matters.</p>}
        <ul className="checklist" data-testid="tasks">
          {data.tasks.map((t) => (
            <li key={t.id} className={t.done ? 'done' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={t.done}
                  disabled={t.done}
                  onChange={() => void earn(api<EarnDay>(`/api/day/tasks/${t.id}/done`, 'POST'), 'Task done')}
                />
                <span className="name">
                  {t.mit && <span className="tag">MIT</span>} {t.task}
                  <small className="muted">
                    {' '}
                    · {t.priority} · {t.energy}
                    {t.context && ` · ${t.context}`}
                    {t.estMin !== null && ` · ${t.estMin}m`}
                  </small>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <form className="form" onSubmit={(e) => void addTask(e)}>
          <input value={task.task} onChange={(e) => setTask({ ...task, task: e.target.value })} placeholder="Add a task" required />
          <Chips options={PRIORITIES} value={task.priority} onPick={(v: Priority) => setTask({ ...task, priority: v })} />
          <Chips options={ENERGIES} value={task.energy} onPick={(v: Energy) => setTask({ ...task, energy: v })} />
          <Chips options={CONTEXTS} value={task.context} onPick={(v) => setTask({ ...task, context: task.context === v ? '' : v })} />
          <label className="inline-label">
            <input type="checkbox" checked={task.mit} onChange={(e) => setTask({ ...task, mit: e.target.checked })} /> Most important task
          </label>
          <button className="btn small">Add task</button>
        </form>
      </div>

      <div className="card">
        <h2>🔁 Habits this week</h2>
        <table className="habitgrid" data-testid="habit-grid">
          <thead>
            <tr>
              <th />
              {WEEKDAYS.map((d) => (
                <th key={d}>{d.slice(0, 2)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.habits.map((h) => (
              <tr key={h.id}>
                <td>{h.name}</td>
                {h.days.map((on, i) => (
                  <td key={i}>
                    <input
                      type="checkbox"
                      aria-label={`${h.name} ${WEEKDAYS[i]}`}
                      checked={on}
                      onChange={(e) =>
                        void earn(api<EarnDay>(`/api/day/habits/${h.id}/toggle`, 'POST', { dayIdx: i, done: e.target.checked }), 'Habit')
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void api<MyDayResponse>('/api/day/habits', 'POST', { name: habit })
              .then((d) => {
                setData(d);
                setHabit('');
              })
              .catch((err: unknown) => show(err instanceof Error ? err.message : 'Could not add'));
          }}
        >
          <input value={habit} onChange={(e) => setHabit(e.target.value)} placeholder="New habit (1–2 is plenty)" required />
          <button className="btn small">Add</button>
        </form>
      </div>

      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          void earn(api<EarnDay>('/api/day/review', 'PUT', review), 'Review saved');
          setRv(null);
        }}
      >
        <h2>🌙 Evening review {data.review && <small className="muted">· saved</small>}</h2>
        <label>
          What got done
          <input value={review.got} onChange={(e) => setRv({ ...review, got: e.target.value })} />
        </label>
        <label>
          What derailed me (no judgment — just data)
          <input value={review.derailed} onChange={(e) => setRv({ ...review, derailed: e.target.value })} />
        </label>
        <label>
          Tomorrow's #1
          <input value={review.tomorrow} onChange={(e) => setRv({ ...review, tomorrow: e.target.value })} />
        </label>
        <small className="muted">Rejection-sensitivity moment today?</small>
        <Chips options={['Yes', 'No'] as const} value={review.rsd} onPick={(v) => setRv({ ...review, rsd: v })} />
        <small className="muted">Energy at the end</small>
        <Chips options={END_ENERGY} value={review.energyEnd} onPick={(v) => setRv({ ...review, energyEnd: v })} />
        <button className="btn">{data.review ? 'Update review' : 'Save review'}</button>
      </form>
      {toast}
    </section>
  );
}
