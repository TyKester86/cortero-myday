import { useEffect, useState } from 'react';
import type { WeeklyPlanFields, WeeklyPlanResponse } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useSession } from '../../session';

const FIELDS: Array<{ key: keyof WeeklyPlanFields; label: string; placeholder: string }> = [
  { key: 'theme', label: 'Theme', placeholder: 'This week is about…' },
  { key: 'top', label: 'Top priority', placeholder: 'The one thing' },
  { key: 'energy', label: 'Energy plan', placeholder: 'How will you protect energy?' },
  { key: 'focus', label: 'Focus', placeholder: 'Where does focus go?' },
  { key: 'rsd', label: 'RSD plan', placeholder: 'If rejection sensitivity hits…' },
  { key: 'review', label: 'Review notes', placeholder: 'End-of-week notes' },
];

const EMPTY: WeeklyPlanFields = { theme: '', top: '', energy: '', focus: '', rsd: '', review: '' };

export default function WeeklyPlan() {
  const { viewing } = useSession();
  const path = viewing ? withMember('/api/weekly-plan', viewing.key) : null;
  const { data, error } = useLoad<WeeklyPlanResponse>(path);
  const [form, setForm] = useState<WeeklyPlanFields>(EMPTY);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data) setForm(data.current ? { ...data.current } : EMPTY);
  }, [data]);

  if (error) return <p className="error">{error}</p>;
  if (!data || !path) return <p className="muted">Loading…</p>;

  const save = async (): Promise<void> => {
    await api(path, 'PUT', form);
    setMsg('Weekly plan saved');
  };

  return (
    <section>
      <h1>Weekly plan</h1>
      <p className="muted">Week of {data.weekStart}</p>
      <div className="card form">
        {FIELDS.map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              value={form[f.key]}
              placeholder={f.placeholder}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          </label>
        ))}
        <button className="btn" onClick={() => void save()}>
          Save weekly plan ✓
        </button>
        {msg && <p className="muted">{msg}</p>}
      </div>
      {data.previous?.theme && <p className="muted">Last week’s theme: {data.previous.theme}</p>}
    </section>
  );
}
