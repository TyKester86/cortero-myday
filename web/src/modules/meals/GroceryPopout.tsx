import { useEffect } from 'react';
import type { GroceryState } from '@myday/shared';
import { api, useLoad } from '../../api';

/**
 * The compact "side-by-side" list (the script's groceryListPage_): opened in a
 * narrow window next to the store's website so you can tick items off as you
 * add them to the cart. No app chrome; refreshes when the window regains focus.
 */
export default function GroceryPopout() {
  const store = new URLSearchParams(window.location.search).get('store') ?? '';
  const { data, error, setData, reload } = useLoad<GroceryState>('/api/grocery');
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  if (error) return <p className="error popout">{error}</p>;
  if (!data) return <p className="muted popout">Loading…</p>;
  const chain = data.chains.find((c) => c.name === store);

  return (
    <div className="popout" data-testid="grocery-popout">
      <h1>Grocery list</h1>
      <p className="muted noprint">Check items off as you add them to your cart.</p>
      {chain && (
        <a className="btn block noprint" href={chain.shopUrl} target="_blank" rel="noreferrer">
          Open {chain.name}
        </a>
      )}
      {data.items.length === 0 ? (
        <p className="muted">List is empty.</p>
      ) : (
        <ul className="checklist">
          {data.items.map((it) => (
            <li key={it.id} className={it.done ? 'done' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={it.done}
                  onChange={(e) => void api<GroceryState>(`/api/grocery/items/${it.id}`, 'PATCH', { done: e.target.checked }).then(setData)}
                />
                <span className="name">
                  {it.item} {it.qty && <span className="muted">{it.qty}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <button className="btn block noprint" onClick={() => window.print()}>
        Print list
      </button>
    </div>
  );
}

/** Open the pop-out beside a store's site. */
export function openGroceryPopout(store: string): void {
  window.open(`/grocery-list?store=${encodeURIComponent(store)}`, 'myday-grocery', 'width=420,height=820');
}
