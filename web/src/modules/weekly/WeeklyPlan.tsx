import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { CalendarOccurrence, CalendarResponse, WeeklyPlanFields, WeeklyPlanResponse } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { NavIcon } from '../../components/NavIcon';
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

const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const timeOf = (o: CalendarOccurrence): string => {
  if (!o.startTime) return 'All day';
  const [h = 0, m = 0] = o.startTime.split(':').map(Number);
  return `${String(((h + 11) % 12) + 1).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** The week at a glance (what's on the calendar), then the week's intentions. */
export default function WeeklyPlan() {
  const { viewing } = useSession();
  const path = viewing ? withMember('/api/weekly-plan', viewing.key) : null;
  const { data, error } = useLoad<WeeklyPlanResponse>(path);
  const start = data?.weekStart ?? null;
  const cal = useLoad<CalendarResponse>(start ? `/api/calendar?from=${start}&to=${addDays(start, 6)}` : null);
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
  const filled = FIELDS.filter((f) => form[f.key].trim()).length;
  const today = ymd(new Date());
  const days = Array.from({ length: 7 }, (_, i) => addDays(data.weekStart, i));
  const occ = cal.data?.occurrences ?? [];
  const upcoming = occ.filter((o) => o.date >= today).slice(0, 6);

  return (
    <section className="plan">
      <header className="page-head centered">
        <h1 className="page-title">Plan</h1>
      </header>
      <div className="sage-card week-card" data-testid="week-card">
        <div className="week-top">
          <span className="label">
            This week • {filled} of {FIELDS.length} planned
          </span>
          <span className="ring big" style={{ ['--p' as string]: Math.round((filled / FIELDS.length) * 100) }} aria-hidden="true" />
        </div>
        <div className="week-strip">
          {days.map((d) => {
            const dt = new Date(`${d}T12:00:00`);
            const has = occ.some((o) => o.date === d);
            return (
              <div key={d} className={d === today ? 'today' : ''}>
                <small>{dt.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</small>
                <b>{dt.getDate()}</b>
                {d === today ? <em>TODAY</em> : <span className={has ? 'dot' : 'dot none'} />}
              </div>
            );
          })}
        </div>
      </div>

      <h2 className="eyebrow">This week</h2>
      <ul className="row-list" data-testid="week-events">
        {upcoming.map((o) => (
          <li key={`${o.eventId}-${o.date}`}>
            <Link to="/calendar" className="row-card event-card">
              <span className="event-top">
                <span className="icon-chip">
                  <NavIcon name="calendar" />
                </span>
                <span className="row-trail">{timeOf(o)}</span>
              </span>
              <b className="row-title">{o.title}</b>
              <span className="row-sub">
                {[new Date(`${o.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' }), o.location, o.people.map((p) => p.name).join(', ')].filter(Boolean).join(' • ')}
              </span>
            </Link>
          </li>
        ))}
        {cal.data && !upcoming.length && (
          <li className="muted small">
            Nothing else on the calendar this week. <Link to="/calendar">Add something →</Link>
          </li>
        )}
      </ul>

      <h2 className="eyebrow">Weekly plan</h2>
      <p className="muted small">Week of {data.weekStart}</p>
      <div className="card form">
        {FIELDS.map((f) => (
          <label key={f.key}>
            {f.label}
            <input value={form[f.key]} placeholder={f.placeholder} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
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
