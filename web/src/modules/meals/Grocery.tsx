import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AddGroceryRequest, GroceryFromWeekResult, GroceryState } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useSession } from '../../session';

/** One household grocery list — one family, one grocery run. */
export default function Grocery() {
  const { viewing } = useSession();
  const { data, error, setData } = useLoad<GroceryState>('/api/grocery');
  const [item, setItem] = useState('');
  const [qty, setQty] = useState('');
  const [staple, setStaple] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (p: Promise<GroceryState>): Promise<void> => setData(await p);

  const add = (e: FormEvent): void => {
    e.preventDefault();
    const body: AddGroceryRequest = { item, qty };
    void run(api<GroceryState>('/api/grocery', 'POST', body)).then(() => {
      setItem('');
      setQty('');
    });
  };

  const fromWeek = async (): Promise<void> => {
    const r = await api<GroceryFromWeekResult>(withMember('/api/grocery/from-week', viewing?.key ?? null), 'POST');
    setData(r.grocery);
    setMsg(`${r.meals} meals → ${r.added} added, ${r.merged} merged, ${r.skipped} already there, ${r.staples} staples`);
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <section>
      <p>
        <Link to="/meals">← Meals</Link>
      </p>
      <h1>Grocery list</h1>
      <button className="btn" onClick={() => void fromWeek()}>
        Build from this week's meals
      </button>
      {msg && <p className="muted">{msg}</p>}

      <form className="inline" onSubmit={add}>
        <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="Add an item" required />
        <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" className="qty" />
        <button className="btn small">Add</button>
      </form>

      {data.items.length === 0 ? (
        <p className="muted">List is empty.</p>
      ) : (
        <ul className="checklist" data-testid="grocery-list">
          {data.items.map((it) => (
            <li key={it.id} className={it.done ? 'done' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={it.done}
                  onChange={(e) => void run(api<GroceryState>(`/api/grocery/${it.id}`, 'PATCH', { done: e.target.checked }))}
                />
                <span className="name">
                  {it.item} {it.qty && <span className="muted">{it.qty}</span>}
                </span>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => void run(api<GroceryState>(`/api/grocery/${it.id}`, 'DELETE'))}
                >
                  ✕
                </button>
              </label>
            </li>
          ))}
        </ul>
      )}
      {data.items.some((i) => i.done) && (
        <button className="link" onClick={() => void run(api<GroceryState>('/api/grocery/clear-done', 'POST'))}>
          Clear checked items
        </button>
      )}

      <div className="card">
        <h2>Staples</h2>
        <p className="muted">Topped up every time you build the list.</p>
        <ul className="plain rows">
          {data.staples.map((s) => (
            <li key={s.id}>
              {s.item}
              <button className="link danger" onClick={() => void run(api<GroceryState>(`/api/grocery/staples/${s.id}`, 'DELETE'))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api<GroceryState>('/api/grocery/staples', 'POST', { item: staple })).then(() => setStaple(''));
          }}
        >
          <input value={staple} onChange={(e) => setStaple(e.target.value)} placeholder="Add a staple" required />
          <button className="btn small">Add</button>
        </form>
      </div>
    </section>
  );
}
