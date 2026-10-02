import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  MEAL_SLOTS,
  WEEKDAYS,
  type AddMealPlanRequest,
  type MealListResponse,
  type MealPlanResponse,
  type MealSlot,
  type NutritionMode,
  type Weekday,
} from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useToast } from '../../components/useToast';
import { useSession } from '../../session';

const PHASES: Array<{ key: '' | 'mine' | NutritionMode; label: string }> = [
  { key: '', label: 'All phases' },
  { key: 'mine', label: 'My phase' },
  { key: 'cutting', label: 'Cutting' },
  { key: 'gaining', label: 'Gaining' },
  { key: 'recomp', label: 'Recomp' },
  { key: 'maintenance', label: 'Maintenance' },
];

/** Placeholder if a picture ever fails to load: never a broken image. */
export const onImgError = (e: React.SyntheticEvent<HTMLImageElement>): void => {
  const img = e.currentTarget;
  if (!img.src.endsWith('/meals/_placeholder.svg')) img.src = '/meals/_placeholder.svg';
};

/** The meal library: browse by picture, filter by cuisine and program phase, add to the week. */
export default function Meals() {
  const { viewing } = useSession();
  const [params, setParams] = useSearchParams();
  const phase = params.get('phase') ?? '';
  const [cuisine, setCuisine] = useState(params.get('country') ?? '');
  const [region, setRegion] = useState('');
  const [day, setDay] = useState<Weekday | ''>('');
  const [slot, setSlot] = useState<MealSlot | ''>('');
  const q = new URLSearchParams();
  if (cuisine) q.set('cuisine', cuisine);
  if (region) q.set('region', region);
  if (phase) q.set('phase', phase);
  const libPath = `/api/meals${q.size ? `?${q.toString()}` : ''}`;
  const library = useLoad<MealListResponse>(viewing ? withMember(libPath, viewing.key) : libPath);
  const plan = useLoad<MealPlanResponse>(viewing ? withMember('/api/meal-plan', viewing.key) : null);
  const { toast, show } = useToast();
  if (!viewing) return null;
  const key = viewing.key;

  const add = async (mealId: number, title: string): Promise<void> => {
    const body: AddMealPlanRequest = { mealId, day: day || null, slot: slot || null };
    try {
      plan.setData(await api<MealPlanResponse>(withMember('/api/meal-plan', key), 'POST', body));
      show(day ? `${title} → ${day}${slot ? ` ${slot}` : ''}` : `${title} added to the week`);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not add');
    }
  };
  const count = (mealId: number): number => plan.data?.meals.filter((m) => m.mealId === mealId).length ?? 0;
  const setPhase = (p: string): void => {
    const next = new URLSearchParams(params);
    if (p) next.set('phase', p);
    else next.delete('phase');
    setParams(next, { replace: true });
  };

  return (
    <section>
      <h1>Meals</h1>
      <p>
        <Link to="/meals/plan">This week's plan ({plan.data?.meals.length ?? 0}) →</Link> ·{' '}
        <Link to="/meals/grocery">Grocery list →</Link>
      </p>

      <h2>Meal library {library.data && <span className="muted small">· {library.data.meals.length} meals</span>}</h2>
      <div className="chips" data-testid="phase-filter">
        {PHASES.filter((p) => p.key !== 'mine' || library.data?.phase).map((p) => (
          <button key={p.key} className={phase === p.key ? 'chip on' : 'chip'} onClick={() => setPhase(p.key)}>
            {p.key === 'mine' && library.data?.phase ? `My phase (${library.data.phase})` : p.label}
          </button>
        ))}
      </div>
      {library.data && (
        <div className="form wide" data-testid="country-filter">
          <label>
            Country of origin
            <select
              value={cuisine}
              onChange={(e) => {
                setCuisine(e.target.value);
                setRegion('');
              }}
              aria-label="Country of origin"
            >
              <option value="">All countries ({library.data.countries.reduce((s, c) => s + c.count, 0)})</option>
              {library.data.countries.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.count})
                </option>
              ))}
            </select>
          </label>
          {(library.data.countries.find((c) => c.name === cuisine)?.regions.length ?? 0) > 0 && (
            <label>
              Region
              <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region of origin">
                <option value="">All of {cuisine}</option>
                {library.data.countries
                  .find((c) => c.name === cuisine)
                  ?.regions.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name} ({r.count})
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
      )}
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
      {library.error && <p className="error">{library.error}</p>}
      {library.data?.meals.length === 0 && <p className="muted">No meals match.</p>}
      <div className="mealgrid" data-testid="meal-library">
        {library.data?.meals.map((m) => (
          <div key={m.id} className="mealcard">
            <Link to={`/meals/${m.id}`}>
              <img src={m.imageUrl} alt="" loading="lazy" onError={onImgError} />
            </Link>
            <div>
              <Link to={`/meals/${m.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                <b>{m.title}</b>
              </Link>
              <small data-testid="meal-origin">
                {m.cuisine}
                {m.region && ` · ${m.region}`}
              </small>
              <small data-testid="meal-nutrition">
                {m.calories !== null && `${m.calories} cal`}
                {m.protein !== null && ` · ${m.protein}g protein`}
              </small>
              {count(m.id) > 0 && <small>in plan ×{count(m.id)}</small>}
              <button className="btn small" onClick={() => void add(m.id, m.title)}>
                Add
              </button>
            </div>
          </div>
        ))}
      </div>
      {toast}
    </section>
  );
}
