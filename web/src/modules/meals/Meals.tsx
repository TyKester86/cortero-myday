import { useState } from 'react';
import { Link } from 'react-router';
import { WEEKDAYS, type MealListResponse, type MealPlanResponse, type Weekday } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useSession } from '../../session';

/** The meal library + this week's meals (per person). */
export default function Meals() {
  const { viewing } = useSession();
  const [cuisine, setCuisine] = useState('');
  const library = useLoad<MealListResponse>(`/api/meals${cuisine ? `?cuisine=${encodeURIComponent(cuisine)}` : ''}`);
  const plan = useLoad<MealPlanResponse>(viewing ? withMember('/api/meal-plan', viewing.key) : null);
  if (!viewing) return null;
  const key = viewing.key;

  const call = async (path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<void> => {
    plan.setData(await api<MealPlanResponse>(withMember(path, key), method, body));
  };
  const inWeek = new Set(plan.data?.meals.map((m) => m.mealId));

  return (
    <section>
      <h1>Meals</h1>
      <p>
        <Link to="/meals/grocery">Grocery list →</Link>
      </p>

      <div className="card" data-testid="meal-week">
        <h2>This week</h2>
        {plan.error && <p className="error">{plan.error}</p>}
        {plan.data && plan.data.meals.length === 0 && <p className="muted">No meals picked yet — add some below.</p>}
        <ul className="plain rows">
          {plan.data?.meals.map((m) => (
            <li key={m.mealId}>
              <Link to={`/meals/${m.mealId}`}>{m.title}</Link>
              <span>
                <select
                  value={m.day ?? ''}
                  onChange={(e) => {
                    const day: Weekday | null = WEEKDAYS.find((d) => d === e.target.value) ?? null;
                    void call(`/api/meal-plan/${m.mealId}`, 'PATCH', { day });
                  }}
                >
                  <option value="">Any day</option>
                  {WEEKDAYS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <button className="link danger" onClick={() => void call(`/api/meal-plan/${m.mealId}`, 'DELETE')}>
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
        {plan.data && plan.data.meals.length > 0 && (
          <button
            className="link"
            onClick={() => confirm('Clear all of this week’s meals?') && void call('/api/meal-plan', 'DELETE')}
          >
            Clear week
          </button>
        )}
      </div>

      <h2>Meal library</h2>
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
              </span>
            </span>
            {inWeek.has(m.id) ? (
              <span className="muted">In week ✓</span>
            ) : (
              <button className="btn small" onClick={() => void call('/api/meal-plan', 'POST', { mealId: m.id })}>
                Add
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
