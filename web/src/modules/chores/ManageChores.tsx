import { useState, type FormEvent } from 'react';
import { WEEKDAYS, type ChoreListResponse, type NewChore, type Weekday } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';

/** Grown-ups add / remove chores and assign them to anyone on the roster. */
export default function ManageChores() {
  const { members, isAdult } = useSession();
  const { data, error, reload } = useLoad<ChoreListResponse>('/api/chores');
  const [name, setName] = useState('');
  const [memberId, setMemberId] = useState<number>(members[0]?.id ?? 0);
  const [days, setDays] = useState<Weekday[]>([...WEEKDAYS]);
  const [points, setPoints] = useState(10);
  const [msg, setMsg] = useState<string | null>(null);

  if (!isAdult) return <p className="muted">Only grown-ups can change chores.</p>;

  const flip = (d: Weekday): void => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const body: NewChore = { name, memberId, days, points };
    try {
      await api('/api/chores', 'POST', body);
      setName('');
      setMsg('Chore added');
      reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not add');
    }
  };

  const remove = async (id: number, label: string): Promise<void> => {
    if (!confirm(`Remove "${label}"? Points already earned stay earned.`)) return;
    await api(`/api/chores/${id}`, 'DELETE');
    reload();
  };

  return (
    <section>
      <h1>Manage chores</h1>
      <form className="card form" onSubmit={(e) => void add(e)}>
        <label>
          Chore
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Unload dishwasher" required />
        </label>
        <label>
          Who
          <select value={memberId} onChange={(e) => setMemberId(Number(e.target.value))}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <div className="days">
          {WEEKDAYS.map((d) => (
            <button type="button" key={d} className={days.includes(d) ? 'chip on' : 'chip'} onClick={() => flip(d)}>
              {d}
            </button>
          ))}
        </div>
        <label>
          Points
          <input type="number" min={0} value={points} onChange={(e) => setPoints(Number(e.target.value))} />
        </label>
        <button className="btn" disabled={!name || !days.length}>
          Add chore
        </button>
        {msg && <p className="muted">{msg}</p>}
      </form>

      {error && <p className="error">{error}</p>}
      {members.map((m) => {
        const mine = data?.chores.filter((c) => c.memberId === m.id) ?? [];
        if (!mine.length) return null;
        return (
          <div key={m.id}>
            <h2>{m.name}</h2>
            <ul className="plain rows">
              {mine.map((c) => (
                <li key={c.id}>
                  <span>
                    {c.name} <span className="muted">· {c.days.join(' ')} · {c.points} pts</span>
                  </span>
                  <button className="link danger" onClick={() => void remove(c.id, c.name)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
