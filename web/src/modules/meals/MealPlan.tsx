import { Link } from 'react-router';
import { MEAL_SLOTS, WEEKDAYS, type MealPlanEntry, type MealPlanResponse, type MealSlot, type SetMealDayRequest } from '@myday/shared';

export const SLOT_LABEL: Record<MealSlot, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };
import { api, useLoad, withMember } from '../../api';
import { useSession } from '../../session';

/** The week, day by day: what's for dinner Monday..Sunday, with daily totals. */
export default function MealPlan() {
  const { viewing } = useSession();
  const path = viewing ? withMember('/api/meal-plan', viewing.key) : null;
  const { data, error, setData } = useLoad<MealPlanResponse>(path);
  if (error) return <p className="error">{error}</p>;
  if (!data || !viewing) return <p className="muted">Loading…</p>;
  const key = viewing.key;

  const setSlot = async (m: MealPlanEntry, value: string): Promise<void> => {
    const body: SetMealDayRequest = { slot: MEAL_SLOTS.find((s) => s === value) ?? null };
    setData(await api<MealPlanResponse>(withMember(`/api/meal-plan/${m.id}`, key), 'PATCH', body));
  };
  const move = async (m: MealPlanEntry, value: string): Promise<void> => {
    const body: SetMealDayRequest = { day: WEEKDAYS.find((d) => d === value) ?? null };
    setData(await api<MealPlanResponse>(withMember(`/api/meal-plan/${m.id}`, key), 'PATCH', body));
  };
  const remove = async (m: MealPlanEntry): Promise<void> => {
    setData(await api<MealPlanResponse>(withMember(`/api/meal-plan/${m.id}`, key), 'DELETE'));
  };
  const clear = async (): Promise<void> => {
    if (!confirm('Clear all of this week’s meals?')) return;
    setData(await api<MealPlanResponse>(withMember('/api/meal-plan', key), 'DELETE'));
  };

  const row = (m: MealPlanEntry) => (
    <li key={m.id}>
      <span>
        {m.slot && <small className="slot">{SLOT_LABEL[m.slot]}</small>}
        <Link to={`/meals/${m.mealId}`}>{m.title}</Link>
        {m.calories !== null && <span className="muted"> · {m.calories} cal</span>}
      </span>
      <span>
        <select aria-label="Meal slot" value={m.slot ?? ''} onChange={(e) => void setSlot(m, e.target.value)}>
          <option value="">Any meal</option>
          {MEAL_SLOTS.map((s) => (
            <option key={s} value={s}>
              {SLOT_LABEL[s]}
            </option>
          ))}
        </select>
        <select aria-label="Move to day" value={m.day ?? ''} onChange={(e) => void move(m, e.target.value)}>
          <option value="">No day</option>
          {WEEKDAYS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button className="link danger" aria-label="Remove" onClick={() => void remove(m)}>
          ✕
        </button>
      </span>
    </li>
  );

  return (
    <section>
      <p>
        <Link to="/meals">← Meal library</Link> · <Link to="/meals/grocery">Grocery list →</Link>
      </p>
      <h1>{data.member.name}'s week of meals</h1>
      <p className="muted">Week of {data.weekStart}</p>

      <div className="week" data-testid="meal-week-days">
        {data.days.map((d) => (
          <div key={d.day} className={d.isToday ? 'card day today' : 'card day'} data-testid={`day-${d.day}`}>
            <div className="day-head">
              <b>
                {d.day} <span className="muted">{d.date.slice(5)}</span>
                {d.isToday && <span className="tag">TODAY</span>}
              </b>
              {d.meals.length > 0 && (
                <small className="muted">
                  {d.calories} cal · {d.protein}g protein
                </small>
              )}
            </div>
            {d.meals.length === 0 ? (
              <p className="muted small">Nothing planned.</p>
            ) : (
              <ul className="plain rows">
                {d.meals.map((m) => (
                  row(m)
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {data.unassigned.length > 0 && (
        <div className="card">
          <h2>Picked, no day yet</h2>
          <ul className="plain rows">
            {data.unassigned.map((m) => (
              row(m)
            ))}
          </ul>
        </div>
      )}
      {data.meals.length === 0 ? (
        <p className="muted">
          Nothing planned yet — <Link to="/meals">pick meals from the library</Link>.
        </p>
      ) : (
        <button className="link" onClick={() => void clear()}>
          Clear week
        </button>
      )}
    </section>
  );
}
