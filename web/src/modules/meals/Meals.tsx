import { useState } from 'react';
import { Link } from 'react-router';
import { MEAL_SLOTS, WEEKDAYS, type AddMealPlanRequest, type MealListResponse, type MealPlanResponse, type MealSlot, type Weekday } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useToast } from '../../components/useToast';
import { useSession } from '../../session';

/** The meal library. Add a meal to the week, or straight onto a day. */
export default function Meals() {
  const { viewing } = useSession();
  const [cuisine, setCuisine] = useState('');
  const [day, setDay] = useState<Weekday | ''>('');
  const [slot, setSlot] = useState<MealSlot | ''>('');
  const library = useLoad<MealListResponse>(`/api/meals${cuisine ? `?cuisine=${encodeURIComponent(cuisine)}` : ''}`);
  const plan = useLoad<MealPlanResponse>(viewing ? withMember('/api/meal-plan', viewing.key) : null);
  const { toast, show } = useToast();
  if (!viewing) return null;
  const key = viewing.key;

  const add = async (mealId: number, title: string): Promise<void> => {
    const body: AddMealPlanRequest = { mealId, day: day || null, slot: slot || null };
    plan.setData(await api<MealPlanResponse>(withMember('/api/meal-plan', key), 'POST', body));
    show(day ? `${title} → ${day}${slot ? ` ${slot}` : ''}` : `${title} added to the week`);
  };
  const count = (mealId: number): number => plan.data?.meals.filter((m) => m.mealId === mealId).length ?? 0;

  return (
    <section>
      <h1>Meals</h1>
      <p>
        <Link to="/meals/plan">This week's plan ({plan.data?.meals.length ?? 0}) →</Link> ·{' '}
        <Link to="/meals/grocery">Grocery list →</Link>
      </p>

      <h2>Meal library</h2>
      <label className="inline-label">
        Add to{' '}
        <select value={day} onChange={(e) => setDay(WEEKDAYS.find((d) => d === e.target.value) ?? '')}>
          <option value="">the week (no day yet)</option>
          {WEEKDAYS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select aria-label="Meal slot" value={slot} onChange={(e) => setSlot(MEAL_SLOTS.find((s) => s === e.target.value) ?? '')}>
          <option value="">any meal</option>
          {MEAL_SLOTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {library.data && (
        <div className="chips">
          <button className={cuisine === '' ? 'chip on' : 'chip'} onClick={() => setCuisine('')}>
            All
          </button>
          {library.data.cuisines.map((c) => (
            <button key={c} className={cuisine === c ? 'chip on' : 'chip'} onClick={() => setCuisine(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      {library.error && <p className="error">{library.error}</p>}
      {library.data?.meals.length === 0 && <p className="muted">No meals loaded yet.</p>}
      <ul className="plain rows" data-testid="meal-library">
        {library.data?.meals.map((m) => (
          <li key={m.id}>
            <span>
              <Link to={`/meals/${m.id}`}>{m.title}</Link>{' '}
              <span className="muted">
                · {m.cuisine}
                {m.calories !== null && ` · ${m.calories} cal`}
                {m.protein !== null && ` · ${m.protein}g protein`}
                {count(m.id) > 0 && ` · in plan ×${count(m.id)}`}
              </span>
            </span>
            <button className="btn small" onClick={() => void add(m.id, m.title)}>
              Add
            </button>
          </li>
        ))}
      </ul>
      {toast}
    </section>
  );
}
