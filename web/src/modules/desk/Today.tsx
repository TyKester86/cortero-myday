import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { BillsResponse, FamilyResponse, HealthToday, HouseholdInfo, MealPlanResponse, MyDayResponse, NotificationsResponse, TodayResponse } from '@myday/shared';
import { api, useLoad } from '../../api';
import QuickNote from '../../components/QuickNote';
import { day as fmtDay, due as fmtDue } from '../../dates';
import { useSession } from '../../session';
import { TodayOnCalendar } from '../calendar/Calendar';

const greeting = (h: number): string => (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening');

/** "Get set up": the handful of things that make MyDay useful, checked off as they happen. */
function SetupChecklist({ hh, program, meals, notif }: { hh: HouseholdInfo; program: boolean; meals: number; notif: NotificationsResponse | null }) {
  const { members } = useSession();
  const [gone, setGone] = useState(false);
  const off = new Set(hh.modulesOff);
  const adults = members.filter((m) => m.kind === 'adult').length;
  const steps = [
    hh.type === 'family' && { key: 'kids', label: 'Add your kids', done: hh.hasKids || !!hh.onboarding.kids, to: '/setup' },
    ['family', 'couple', 'empty_nesters', 'retired'].includes(hh.type) && { key: 'invite', label: 'Invite your partner', done: adults > 1 || !!hh.onboarding.invite, to: '/setup' },
    !off.has('health') && { key: 'build', label: 'Pick a training plan', done: program, to: '/health' },
    !off.has('meals') && { key: 'meals', label: 'Plan this week’s meals', done: meals > 0, to: '/meals' },
    { key: 'nudge', label: 'Choose your reminder time', done: !!notif?.prefs.enabled, to: '/settings' },
    !off.has('money') && { key: 'bank', label: 'Link a bank (optional)', done: !!hh.onboarding.bank, to: '/money' },
  ].filter(Boolean) as Array<{ key: string; label: string; done: boolean; to: string }>;
  const left = steps.filter((s) => !s.done).length;
  if (gone || hh.onboarding.checklist || left === 0) return null;
  const dismiss = async (): Promise<void> => {
    setGone(true);
    await api(`/api/onboarding/checklist`, 'POST', { skipped: true }).catch(() => undefined);
  };
  return (
    <div className="card" data-testid="setup-checklist">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          Get set up <small className="muted">· {steps.length - left} of {steps.length}</small>
        </h2>
        <button className="link small" onClick={() => void dismiss()}>
          Hide
        </button>
      </div>
      <ul className="plain setup-steps">
        {steps.map((s) => (
          <li key={s.key} className={s.done ? 'done' : ''}>
            <span aria-hidden="true">{s.done ? '✓' : '○'}</span>{' '}
            {s.done ? s.label : <Link to={s.to}>{s.label}</Link>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The grown-up's home: one place for what's next, today's workout and meals,
 * the kids at a glance and — after 5 pm — the evening close-out. Replaces the
 * separate chore board / My day / command center homes.
 */
export default function Today() {
  const { me } = useSession();
  const hh = me.household;
  const off = new Set(hh?.modulesOff ?? []);
  const hour = new Date().getHours();
  const evening = hour >= 17;
  const day = useLoad<MyDayResponse>('/api/day');
  const mine = useLoad<TodayResponse>('/api/chores/today');
  const health = useLoad<HealthToday>(off.has('health') ? null : '/api/workouts/today');
  const meals = useLoad<MealPlanResponse>(off.has('meals') ? null : '/api/meal-plan');
  const family = useLoad<FamilyResponse>(hh?.hasKids ? '/api/family' : null);
  const bills = useLoad<BillsResponse>(off.has('money') ? null : '/api/bills');
  const notif = useLoad<NotificationsResponse>('/api/notifications');
  const [task, setTask] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const d = day.data;
  const open = (d?.tasks ?? []).filter((t) => !t.done).sort((a, b) => Number(b.mit) - Number(a.mit));
  const doneTasks = (d?.tasks ?? []).filter((t) => t.done);
  const todayMeals = meals.data?.days.find((x) => x.isToday)?.meals ?? [];
  const myChores = mine.data?.chores ?? [];

  const finish = async (id: number): Promise<void> => {
    try {
      day.setData((await api<{ day: MyDayResponse }>(`/api/day/tasks/${id}/done`, 'POST')).day);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const addTask = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!task.trim()) return;
    day.setData(await api<MyDayResponse>('/api/day/tasks', 'POST', { task: task.trim(), priority: 'Important', energy: 'Low Brain', context: '', estMin: null, mit: false }));
    setTask('');
  };
  const toggleChore = async (id: number, done: boolean): Promise<void> => {
    await api(`/api/chores/${id}/toggle`, 'POST', { done });
    mine.reload();
  };

  const closeOut = (
    <div className="card" data-testid="close-out">
      <h2>Close the day</h2>
      <p className="small">
        {doneTasks.length} done · {open.length} still open — {open.length ? 'they’ll be here tomorrow, no need to finish everything.' : 'nice.'}
      </p>
      <Link className="btn small" to="/day#review">
        {d?.review ? 'Edit your evening review' : 'Two-minute evening review'}
      </Link>
    </div>
  );

  return (
    <section data-testid="today-adult">
      <h1>
        {greeting(hour)}, {me.member?.name ?? me.name}
      </h1>
      <p className="muted">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <QuickNote />
      {msg && <p className="error">{msg}</p>}
      {hh && <SetupChecklist hh={hh} program={!!health.data?.program} meals={meals.data?.meals.length ?? 0} notif={notif.data} />}
      <TodayOnCalendar />
      <div className="desk-grid two">
        <div>
          {evening && closeOut}
          <div className="card" data-testid="next-up">
            <h2>
              Next up {d?.energyNote && <small className="muted">· {d.energyNote}</small>}
            </h2>
            {d && !d.checkin && !evening && (
              <p className="small">
                <Link to="/day">30-second check-in</Link> — your list re-orders by your energy.
              </p>
            )}
            <ul className="plain rows">
              {open.slice(0, 3).map((t) => (
                <li key={t.id}>
                  <span>
                    {t.mit && <span className="tag">MIT</span>} {t.task}
                  </span>
                  <button className="btn small" onClick={() => void finish(t.id)}>
                    Done
                  </button>
                </li>
              ))}
              {d && open.length === 0 && <li className="muted">Nothing open. Add the one thing that matters today.</li>}
            </ul>
            <form className="inline" onSubmit={(e) => void addTask(e)}>
              <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Add a task" aria-label="Add a task" />
              <button className="btn small">Add</button>
            </form>
            <Link className="small" to="/day">
              {open.length > 3 ? `All ${open.length} tasks, habits and check-in →` : 'Tasks, habits and check-in →'}
            </Link>
          </div>
          {myChores.length > 0 && (
            <div className="card">
              <h2>Your chores</h2>
              <ul className="plain rows">
                {myChores.map((c) => (
                  <li key={c.id}>
                    <label>
                      <input type="checkbox" checked={c.done} onChange={(e) => void toggleChore(c.id, e.target.checked)} /> {c.name}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {family.data && family.data.kids.length > 0 && (
            <div className="card" data-testid="kids-glance">
              <h2>The kids</h2>
              <ul className="plain rows">
                {family.data.kids.map((k) => (
                  <li key={k.member.id}>
                    <span>
                      <b>{k.member.name}</b>{' '}
                      <small className="muted">
                        · chores {k.choresDone}/{k.choresToday}
                        {k.openHomework > 0 && ` · ${k.openHomework} homework${k.overdueHomework ? ` (${k.overdueHomework} late)` : ''}`}
                        {k.pendingRewards > 0 && ` · ${k.pendingRewards} reward${k.pendingRewards === 1 ? '' : 's'} to approve`}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
              <Link className="small" to="/family">
                Family →
              </Link>
            </div>
          )}
        </div>
        <div>
          {!off.has('health') && (
            <div className="card">
              <h2>Workout</h2>
              {!health.data ? (
                <p className="muted small">…</p>
              ) : !health.data.hasPlan ? (
                <p className="small">
                  No plan yet. <Link to="/health">Pick a training plan →</Link>
                </p>
              ) : health.data.session ? (
                <p className="small">
                  {health.data.dayCompleted ? '✓ Done today: ' : 'Today: '}
                  <b>{health.data.session.dayName}</b> · {health.data.session.exercises.length} exercises · <Link to="/health">Open →</Link>
                </p>
              ) : (
                <p className="small">
                  Rest day. {health.data.program?.cardio ? 'Easy movement counts.' : 'Walk, stretch, hydrate.'} <Link to="/health">Health →</Link>
                </p>
              )}
            </div>
          )}
          {!off.has('meals') && (
            <div className="card">
              <h2>Meals today</h2>
              {todayMeals.length === 0 ? (
                <p className="small">
                  Nothing planned. <Link to="/meals">Pick a few →</Link>
                </p>
              ) : (
                <ul className="plain small">
                  {todayMeals.map((m) => (
                    <li key={m.id}>
                      <Link to={`/meals/${m.mealId}`}>{m.title}</Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link className="small" to="/meals/grocery">
                Grocery list →
              </Link>
            </div>
          )}
          {!off.has('money') && bills.data && bills.data.dueSoon.length > 0 && (
            <div className="card">
              <h2>Bills coming up</h2>
              <ul className="plain small">
                {bills.data.dueSoon.slice(0, 4).map((b) => (
                  <li key={b.name + b.date}>
                    {fmtDay(b.date)} · {b.name} · ${b.amount}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d && (
            <div className="card">
              <h2>Today’s score</h2>
              <p className="small">
                <b>{d.daily.total}</b> of 100 · level {d.xp.level} <span className="muted">· {d.xp.title}</span> · <Link to="/score">Progress →</Link>
              </p>
            </div>
          )}
          {!evening && closeOut}
          {mine.data && mine.data.homework.length > 0 && (
            <div className="card">
              <h2>Your homework</h2>
              <ul className="plain small">
                {mine.data.homework.map((h) => (
                  <li key={h.id}>
                    {h.assignment} {h.due && <span className="muted">· {fmtDue(h.due)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
