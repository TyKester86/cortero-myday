import { useRef, useState, type FormEvent } from 'react';
import { WEEKDAYS, type ChoreListResponse, type NewChore, type Weekday } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { useSession } from '../../session';

/** Grown-ups add / remove chores and assign them to anyone on the roster. */
export default function ManageChores() {
  const { members, isAdult } = useSession();
  const { data, error, reload } = useLoad<ChoreListResponse>('/api/chores');
  const [name, setName] = useState('');
  const kids = members.filter((m) => m.kind === 'kid');
  const grownUps = members.filter((m) => m.kind !== 'kid');
  // Default "Who" to the first kid (chores are mostly for kids); 0 = not picked yet.
  const [picked, setPicked] = useState<number>(0);
  const memberId = picked || kids[0]?.id || members[0]?.id || 0;
  const nameRef = useRef<HTMLInputElement>(null);
  const [days, setDays] = useState<Weekday[]>([...WEEKDAYS]);
  const [points, setPoints] = useState(10);
  const [msg, setMsg] = useState<string | null>(null);
  const confirm = useConfirm();

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
    if (!(await confirm({ title: `Remove "${label}"?`, body: 'Points already earned stay earned.', confirmLabel: 'Remove', danger: true }))) return;
    await api(`/api/chores/${id}`, 'DELETE');
    reload();
  };

  return (
    <section>
      <h1>Manage chores</h1>
      <form className="card form" onSubmit={(e) => void add(e)}>
        <label>
          Chore
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="Unload dishwasher" required />
        </label>
        <label>
          Who
          <select value={memberId} onChange={(e) => setPicked(Number(e.target.value))} data-testid="chore-who">
            {kids.length > 0 && (
              <optgroup label="Kids">
                {kids.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Grown-ups">
              {grownUps.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
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
      {kids.length > 0 && <h2>The kids</h2>}
      {kids.map((m) => (
        <ChoreGroup
          key={m.id}
          name={m.name}
          chores={data?.chores.filter((c) => c.memberId === m.id) ?? []}
          onRemove={(id, label) => void remove(id, label)}
          onAdd={() => {
            setPicked(m.id);
            nameRef.current?.focus();
            nameRef.current?.scrollIntoView({ block: 'center' });
          }}
        />
      ))}
      {grownUps.some((m) => data?.chores.some((c) => c.memberId === m.id)) && <h2>Grown-ups</h2>}
      {grownUps.map((m) => {
        const mine = data?.chores.filter((c) => c.memberId === m.id) ?? [];
        return mine.length ? <ChoreGroup key={m.id} name={m.name} chores={mine} onRemove={(id, label) => void remove(id, label)} /> : null;
      })}
    </section>
  );
}

/** One person's chores. Kids always get a section (with a way to add one), even before they have any. */
function ChoreGroup({
  name,
  chores,
  onRemove,
  onAdd,
}: {
  name: string;
  chores: ChoreListResponse['chores'];
  onRemove: (id: number, label: string) => void;
  onAdd?: () => void;
}) {
  return (
    <div className="card" data-testid={`chores-of-${name}`}>
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>
          {name}
        </h3>
        <small className="muted">{chores.length ? `${chores.length} chore${chores.length === 1 ? '' : 's'}` : 'no chores yet'}</small>
      </div>
      {chores.length > 0 && (
        <ul className="plain rows">
          {chores.map((c) => (
            <li key={c.id}>
              <span>
                {c.name} <span className="muted">· {c.days.join(' ')} · {c.points} pts</span>
              </span>
              <button className="link danger" onClick={() => onRemove(c.id, c.name)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {onAdd && (
        <button className="link small" onClick={onAdd}>
          + Add a chore for {name}
        </button>
      )}
    </div>
  );
}
