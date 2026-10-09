import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { BillsResponse, FamilyResponse, HealthToday, HouseholdInfo, MealPlanResponse, MyDayResponse, NotificationsResponse, ScoreSummary, TodayResponse } from '@myday/shared';
import { api, useLoad } from '../../api';
import QuickNote from '../../components/QuickNote';
import { day as fmtDay, due as fmtDue } from '../../dates';
import { useSession } from '../../session';
import { TodayOnCalendar } from '../calendar/Calendar';
import { count } from '../../format';
import { NavIcon } from '../../components/NavIcon';

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
  const score = useLoad<ScoreSummary>('/api/score');
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

  // Today's checklist: open tasks (most important first) and your chores, done or not.
  const doneCount = doneTasks.length + myChores.filter((c) => c.done).length;
  const totalCount = (d?.tasks.length ?? 0) + myChores.length;
  const pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
  const ptsLeft = myChores.filter((c) => !c.done).reduce((n, c) => n + c.points, 0);
  const streak = score.data?.streak?.current ?? 0;
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <section data-testid="today-adult" className="today">
      <header className="page-head">
        <h1 className="page-title">Today</h1>
        <p className="page-sub">
          {greeting(hour)}, {me.member?.name ?? me.name} · {dateLine}
        </p>
      </header>
      <div className="today-quick">
        <QuickNote />
      </div>
      {msg && <p className="error">{msg}</p>}
      {hh && <SetupChecklist hh={hh} program={!!health.data?.program} meals={meals.data?.meals.length ?? 0} notif={notif.data} />}

      <h2 className="eyebrow rule">Today’s checklist</h2>
      <div data-testid="next-up">
        <ul className="check-list">
          {open.slice(0, 5).map((t) => (
            <li key={`t${t.id}`} className="check-card">
              <button type="button" className="round-check open" aria-label={`Done: ${t.task}`} title="Done" onClick={() => void finish(t.id)}>
                <CheckMark />
              </button>
              <span>
                <b>{t.task}</b>
                <span className="check-sub">{t.mit ? 'Most important today' : t.priority}</span>
                <span className="check-meta">
                  {t.energy}
                  {t.estMin ? ` • ${t.estMin} min` : ''}
                  {t.context ? ` • ${t.context}` : ''}
                </span>
              </span>
              <span className="check-pts">{t.mit ? 'MIT' : ''}</span>
            </li>
          ))}
          {myChores.map((c) => (
            <li key={`c${c.id}`} className={c.done ? 'check-card done' : 'check-card'}>
              <button
                type="button"
                role="checkbox"
                aria-checked={c.done}
                aria-label={c.name}
                className={c.done ? 'round-check' : 'round-check open'}
                onClick={() => void toggleChore(c.id, !c.done)}
              >
                <CheckMark />
              </button>
              <span>
                <b>{c.name}</b>
                <span className="check-meta">Chore • {c.done ? 'done today' : 'today'}</span>
              </span>
              <span className="check-pts">+{c.points} pts</span>
            </li>
          ))}
        </ul>
        {d && open.length === 0 && myChores.length === 0 && <p className="muted">Nothing open. Add the one thing that matters today.</p>}
        {d && !d.checkin && !evening && (
          <p className="small">
            <Link to="/day">30-second check-in</Link> — your list re-orders by your energy{d.energyNote ? ` (${d.energyNote})` : ''}.
          </p>
        )}
        <form className="inline" onSubmit={(e) => void addTask(e)}>
          <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Add a task" aria-label="Add a task" />
          <button className="btn small">Add</button>
        </form>
        <Link className="small" to="/day">
          {open.length > 5 ? `All ${open.length} tasks, habits and check-in →` : 'Tasks, habits and check-in →'}
        </Link>
      </div>

      {d && (
        <Link to="/score" className="card stat-card" data-testid="today-streak">
          <span className="icon-tile">
            <NavIcon name="flame" />
          </span>
          <span>
            <b className="row-title">{streak ? `Your streak: ${count(streak, 'day')}` : `Today’s score: ${d.daily.total} of 100`}</b>
            <span className="row-sub">
              Level {d.xp.level} · {d.xp.title}
              {d.xp.next ? ` · ${d.xp.next.at - d.xp.total} XP to ${d.xp.next.title}` : ''}
            </span>
          </span>
          <span className="stat-big">
            <b>{score.data ? score.data.totalPoints : d.xp.total}</b>
            <small>{score.data ? 'Total points' : 'XP'}</small>
          </span>
        </Link>
      )}
      {totalCount > 0 && (
        <div className="card" data-testid="today-goal">
          <b className="row-title">Today’s progress</b>
          <span className="row-sub" style={{ color: 'var(--hy-text)' }}>
            {pct}% complete
          </span>
          <div className="goal-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <span className="row-sub">
            {doneCount} of {totalCount} done{ptsLeft ? ` • +${ptsLeft} pts available` : ''}
          </span>
        </div>
      )}
      {evening && closeOut}

      <h2 className="eyebrow">Also today</h2>
      <TodayOnCalendar />
      <ul className="row-list today-more">
        {family.data && family.data.kids.length > 0 && (
          <li>
            <Link to="/family" className="row-card" data-testid="kids-glance">
              <span className="row-icon">
                <NavIcon name="family" />
              </span>
              <span>
                <b className="row-title">The kids</b>
                {family.data.kids.map((k) => (
                  <span key={k.member.id} className="row-sub">
                    {k.member.name} · chores {k.choresDone}/{k.choresToday}
                    {k.openHomework > 0 && ` · ${k.openHomework} homework${k.overdueHomework ? ` (${k.overdueHomework} late)` : ''}`}
                    {k.pendingRewards > 0 && ` · ${k.pendingRewards} reward${k.pendingRewards === 1 ? '' : 's'} to approve`}
                  </span>
                ))}
              </span>
              <span className="row-chev">
                <NavIcon name="chevron" />
              </span>
            </Link>
          </li>
        )}
        {!off.has('health') && (
          <li>
            <Link to="/health" className="row-card">
              <span className="row-icon">
                <NavIcon name="dumbbell" />
              </span>
              <span>
                <b className="row-title">Workout</b>
                <span className="row-sub">
                  {!health.data
                    ? '…'
                    : !health.data.hasPlan
                      ? 'No plan yet — pick a training plan'
                      : health.data.session
                        ? `${health.data.dayCompleted ? 'Done today: ' : 'Today: '}${health.data.session.dayName} · ${count(health.data.session.exercises.length, 'exercise')}`
                        : `Rest day. ${health.data.program?.cardio ? 'Easy movement counts.' : 'Walk, stretch, hydrate.'}`}
                </span>
              </span>
              <span className="row-chev">
                <NavIcon name="chevron" />
              </span>
            </Link>
          </li>
        )}
        {!off.has('meals') && (
          <li>
            <Link to={todayMeals[0] ? `/meals/${todayMeals[0].mealId}` : '/meals'} className="row-card">
              <span className="row-icon">
                <NavIcon name="plate" />
              </span>
              <span>
                <b className="row-title">Meals today</b>
                <span className="row-sub">{todayMeals.length ? todayMeals.map((m) => m.title).join(' · ') : 'Nothing planned — pick a few'}</span>
              </span>
              <span className="row-chev">
                <NavIcon name="chevron" />
              </span>
            </Link>
          </li>
        )}
        {!off.has('money') && bills.data && bills.data.dueSoon.length > 0 && (
          <li>
            <Link to="/bills" className="row-card">
              <span className="row-icon">
                <NavIcon name="receipt" />
              </span>
              <span>
                <b className="row-title">Bills coming up</b>
                {bills.data.dueSoon.slice(0, 3).map((b) => (
                  <span key={b.name + b.date} className="row-sub">
                    {fmtDay(b.date)} · {b.name}
                  </span>
                ))}
              </span>
              <span className="row-trail">${bills.data.dueSoon.slice(0, 3).reduce((n, b) => n + b.amount, 0)}</span>
            </Link>
          </li>
        )}
        {mine.data && mine.data.homework.length > 0 && (
          <li>
            <div className="row-card">
              <span className="row-icon">
                <NavIcon name="homework" />
              </span>
              <span>
                <b className="row-title">Your homework</b>
                {mine.data.homework.map((h) => (
                  <span key={h.id} className="row-sub">
                    {h.assignment} {h.due && `· ${fmtDue(h.due)}`}
                  </span>
                ))}
              </span>
              <span />
            </div>
          </li>
        )}
      </ul>
      {!evening && closeOut}
    </section>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5.5 12.5 4.2 4.2 8.8-9.2" />
    </svg>
  );
}
