import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { WEEKDAYS, type MealDetail as MealDetailData, type MealPlanResponse, type Weekday } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useSession } from '../../session';
import { onImgError } from './Meals';

/** One meal: picture, macros, ingredients, numbered steps — and add it to this week on chosen days. */
export default function MealDetail() {
  const { id } = useParams();
  const { viewing } = useSession();
  const { data, error } = useLoad<MealDetailData>(id ? `/api/meals/${encodeURIComponent(id)}` : null);
  const [days, setDays] = useState<Weekday[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const add = async (): Promise<void> => {
    if (!viewing) return;
    try {
      const targets: Array<Weekday | null> = days.length ? days : [null];
      for (const d of targets) {
        await api<MealPlanResponse>(withMember('/api/meal-plan', viewing.key), 'POST', { mealId: data.id, day: d, slot: null });
      }
      setMsg(days.length ? `Added for ${days.join(', ')} ✓` : 'Added to this week ✓');
      setDays([]);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not add');
    }
  };

  return (
    <section>
      <p>
        <Link to="/meals">← Meals</Link>
      </p>
      <img className="mealhero" src={data.imageUrl} alt={data.title} onError={onImgError} />
      <h1>{data.title}</h1>
      <p className="muted">
        {data.cuisine}
        {data.calories !== null && ` · ${data.calories} cal`}
        {data.protein !== null && ` · ${data.protein}g protein`}
        {data.carbs !== null && ` · ${data.carbs}g carbs`}
        {data.fat !== null && ` · ${data.fat}g fat`}
      </p>
      <p className="small">
        {data.servings !== null && <span className="pill">Serves {data.servings}</span>}{' '}
        {data.prepMin !== null && <span className="pill">{data.prepMin} min</span>}{' '}
        {data.phaseTags.map((t) => (
          <span key={t} className="pill good" style={{ marginRight: 4 }}>
            {t}
          </span>
        ))}
      </p>

      <div className="card" data-testid="add-to-week">
        <b>Add to this week</b>
        <p className="muted small">Pick days (or none to decide later).</p>
        <div className="days">
          {WEEKDAYS.map((d) => (
            <button key={d} className={days.includes(d) ? 'chip on' : 'chip'} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>
              {d}
            </button>
          ))}
        </div>
        <div className="row">
          <button className="btn small" onClick={() => void add()}>
            Add to week
          </button>
          <Link to="/meals/grocery">Build grocery list →</Link>
        </div>
        {msg && <p className="muted small">{msg}</p>}
      </div>

      <h2>Ingredients</h2>
      <ul>
        {data.ingredients.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <h2>Steps</h2>
      <ol className="steps">
        {data.steps.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
    </section>
  );
}
