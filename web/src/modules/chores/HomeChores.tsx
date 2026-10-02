import { useState } from 'react';
import { Link } from 'react-router';
import type { PerfectWeekResult, TodayResponse, ToggleChoreResponse } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useSession } from '../../session';

/** Today's checklist for one person. Checking a chore pays out instantly. */
export default function HomeChores() {
  const { viewing } = useSession();
  const key = viewing?.key ?? null;
  const { data, error, setData } = useLoad<TodayResponse>(key ? withMember('/api/chores/today', key) : null);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [perfect, setPerfect] = useState<PerfectWeekResult | null>(null);

  if (!viewing) return <p className="muted">Your account isn't linked to anyone in the household yet.</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const toggle = async (id: number, done: boolean): Promise<void> => {
    setBusy(id);
    try {
      const r = await api<ToggleChoreResponse>(`/api/chores/${id}/toggle`, 'POST', { done });
      setData(r.today);
      setTotal(r.totalPoints);
      const pts = r.today.chores.find((c) => c.id === id)?.points ?? 0;
      if (done) setToast(r.leveledUp ? `Level up! Lv ${r.xp.level} · ${r.xp.title} 🎉` : `+${pts} points`);
      if (r.perfectWeek?.awarded) setPerfect(r.perfectWeek);
      else if (r.perfectWeek?.clean) setToast('Perfect week so far.');
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 2200);
    }
  };

  const left = data.chores.filter((c) => !c.done);
  return (
    <section>
      <h1>
        {data.member.name}'s {data.weekday}
      </h1>
      <div className="stats">
        <div className="stat">
          <b data-testid="points-earned">{data.pointsEarned}</b>
          <small>earned today</small>
        </div>
        <div className="stat">
          <b>{data.pointsToday}</b>
          <small>on the board</small>
        </div>
        {total !== null && (
          <div className="stat">
            <b data-testid="points-total">{total}</b>
            <small>total points</small>
          </div>
        )}
      </div>

      {data.curfew && (
        <div className="card curfew" data-testid="curfew">
          {data.curfew.phoneOff && (
            <span>
              📵 Phone off <b>{data.curfew.phoneOff}</b>
            </span>
          )}
          {data.curfew.curfew && (
            <span>
              🏠 Home by <b>{data.curfew.curfew}</b>
            </span>
          )}
        </div>
      )}

      {left[0] && (
        <div className="now card">
          <small>NOW</small>
          <div className="now-name">{left[0].name}</div>
        </div>
      )}

      {data.chores.length === 0 ? (
        <p className="muted">Nothing scheduled today.</p>
      ) : (
        <ul className="checklist">
          {data.chores.map((c) => (
            <li key={c.id} className={c.done ? 'done' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={c.done}
                  disabled={busy === c.id}
                  onChange={(e) => void toggle(c.id, e.target.checked)}
                />
                <span className="name">{c.name}</span>
                <span className="pts">{c.points} pts</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {data.homework.length > 0 && (
        <>
          <h2>
            Homework <Link to="/homework" className="small-link">open →</Link>
          </h2>
          <ul className="plain">
            {data.homework.map((h) => (
              <li key={h.id} className={h.overdue ? 'warn' : ''}>
                {h.assignment} {h.subject && <span className="muted">· {h.subject}</span>}
                {h.due && <span className="muted"> · due {h.due}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
      {perfect && (
        <div className="overlay" onClick={() => setPerfect(null)}>
          <div className="celebrate">
            <div className="big">PERFECT WEEK</div>
            <p>
              Nothing missed all week.
              <br />
              Week's points doubled (+{perfect.bonus})
            </p>
            <button className="btn" onClick={() => setPerfect(null)}>
              Done
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
