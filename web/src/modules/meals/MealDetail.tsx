import { Link, useParams } from 'react-router';
import type { MealDetail as MealDetailData } from '@myday/shared';
import { useLoad } from '../../api';

export default function MealDetail() {
  const { id } = useParams();
  const { data, error } = useLoad<MealDetailData>(id ? `/api/meals/${encodeURIComponent(id)}` : null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <section>
      <p>
        <Link to="/meals">← Meals</Link>
      </p>
      <h1>{data.title}</h1>
      <p className="muted">
        {data.cuisine}
        {data.calories !== null && ` · ${data.calories} cal`}
        {data.protein !== null && ` · ${data.protein}g protein`}
        {data.carbs !== null && ` · ${data.carbs}g carbs`}
        {data.fat !== null && ` · ${data.fat}g fat`}
      </p>
      <h2>Ingredients</h2>
      <ul>
        {data.ingredients.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <h2>Steps</h2>
      <ol>
        {data.steps.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
    </section>
  );
}
