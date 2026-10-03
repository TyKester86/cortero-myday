import { useState } from 'react';
import { Link } from 'react-router';
import type { BillsResponse, EngagementResponse, MealPlanResponse, MyDayResponse } from '@myday/shared';
import { api, useLoad } from '../../api';
import QuickNote from '../../components/QuickNote';
import { day as fmtDay } from '../../dates';

/**
 * Desktop command center. Morning: check-in state, energy-ordered tasks,
 * today's meals, what's due. Evening close-out: what got done, the wins,
 * what's left to roll to tomorrow, and the evening review. Dense,
 * multi-column, keyboard-friendly (press ? for shortcuts).
 */
export default function CommandCenter() {
  const hour = new Date().getHours();
  const [mode, setMode] = useState<'morning' | 'evening'>(hour >= 16 ? 'evening' : 'morning');
  const day = useLoad<MyDayResponse>('/api/day');
  const eng = useLoad<EngagementResponse>('/api/engagement');
  const bills = useLoad<BillsResponse>('/api/bills');
  const meals = useLoad<MealPlanResponse>('/api/meal-plan');
  const [msg, setMsg] = useState<string | null>(null);
  const d = day.data;
  const done = d?.tasks.filter((t) => t.done) ?? [];
  const open = d?.tasks.filter((t) => !t.done) ?? [];
  const todayMeals = meals.data?.days.find((x) => x.isToday)?.meals ?? [];

  const finish = async (id: number): Promise<void> => {
    try {
      const r = await api<{ day: MyDayResponse }>(`/api/day/tasks/${id}/done`, 'POST');
      day.setData(r.day);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };

  return (
    <section data-testid={`command-${mode}`}>
      <div className="row">
        <h1 className="grow">{mode === 'morning' ? 'Good morning' : 'Evening close-out'}</h1>
        <div className="chips">
          <button className={mode === 'morning' ? 'chip on' : 'chip'} onClick={() => setMode('morning')}>
            Morning
          </button>
          <button className={mode === 'evening' ? 'chip on' : 'chip'} onClick={() => setMode('evening')}>
            Evening
          </button>
        </div>
        <span className="desk-hint">
          Press <kbd>?</kbd> for shortcuts
        </span>
      </div>
      <QuickNote />
      {msg && <p className="error">{msg}</p>}
      <div className="desk-grid">
        {mode === 'morning' ? (
          <>
            <div className="card desk-span2">
              <h2>Next up {d?.energyNote && <small className="muted">· {d.energyNote}</small>}</h2>
              {!d?.checkin && (
                <p>
                  <Link to="/day">Do your 30-second check-in</Link> — tasks re-order by your energy.
                </p>
              )}
              <ul className="plain rows">
                {open.map((t) => (
                  <li key={t.id}>
                    <span>
                      {t.mit && <span className="pill sun">MIT</span>} {t.task} <small className="muted">· {t.energy} · {t.priority}</small>
                    </span>
                    <button className="btn small" onClick={() => void finish(t.id)}>
                      Done
                    </button>
                  </li>
                ))}
                {open.length === 0 && <li className="muted">Nothing open. Add one thing that matters on My day.</li>}
              </ul>
            </div>
            <div className="card">
              <h2>Score</h2>
              <div className="bigscore">
                <b>{d?.daily.total ?? 0}</b>
                <span className="muted">of 100 today</span>
              </div>
            </div>
            <div className="card">
              <h2>Today's meals</h2>
              {todayMeals.length === 0 ? <p className="muted">None planned. <Link to="/meals">Pick some</Link></p> : (
                <ul className="plain">
                  {todayMeals.map((m) => (
                    <li key={m.id}>
                      <Link to={`/meals/${m.mealId}`}>{m.title}</Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link to="/meals/grocery">Grocery list →</Link>
            </div>
            <div className="card">
              <h2>Coming up</h2>
              {bills.data?.dueSoon.length ? (
                <ul className="plain small">
                  {bills.data.dueSoon.map((b) => (
                    <li key={b.name + b.date}>
                      {fmtDay(b.date)} · {b.name} · ${b.amount}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No bills in the next week.</p>
              )}
            </div>
            <div className="card">
              <h2>Family</h2>
              {eng.data?.challenge ? (
                <>
                  <p className="small">{eng.data.challenge.title}</p>
                  <div className="bar">
                    <i style={{ width: `${Math.round((eng.data.challenge.progress / eng.data.challenge.goal) * 100)}%` }} />
                  </div>
                </>
              ) : (
                <p className="muted small">—</p>
              )}
              <Link to="/chores">Chores today →</Link> · <Link to="/wins">Wins →</Link>
            </div>
          </>
        ) : (
          <>
            <div className="card">
              <h2>Got done ({done.length})</h2>
              <ul className="plain small">
                {done.map((t) => (
                  <li key={t.id}>✓ {t.task}</li>
                ))}
                {done.length === 0 && <li className="muted">Rest days count too.</li>}
              </ul>
            </div>
            <div className="card">
              <h2>Still open ({open.length})</h2>
              <p className="muted small">They'll be here tomorrow — no need to finish everything.</p>
              <ul className="plain small">
                {open.map((t) => (
                  <li key={t.id}>{t.task}</li>
                ))}
              </ul>
            </div>
            <div className="card">
              <h2>Close the day</h2>
              <p className="small">{d?.review ? '✓ Evening review saved.' : 'Two minutes: what went right, what derailed, tomorrow’s one thing.'}</p>
              <Link className="btn small" to="/day">
                {d?.review ? 'Edit review' : 'Do the review'}
              </Link>
            </div>
            <div className="card desk-span2">
              <h2>Today's wins</h2>
              {(eng.data?.wins ?? []).slice(0, 10).map((w, i) => (
                <div key={i} className="win">
                  <span className="emoji">{w.emoji}</span>
                  <span>
                    <b>{w.who}</b> {w.text} <small className="muted">{fmtDay(w.at)}</small>
                  </span>
                </div>
              ))}
              {eng.data?.wins.length === 0 && <p className="muted">Wins show up here as they happen.</p>}
            </div>
            <div className="card">
              <h2>Score</h2>
              <div className="bigscore">
                <b>{d?.daily.total ?? 0}</b>
                <span className="muted">of 100</span>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
