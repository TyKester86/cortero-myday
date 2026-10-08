import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type {
  AddCustomStoreRequest,
  AddGroceryRequest,
  GroceryChain,
  GroceryFavorite,
  GroceryFromWeekResult,
  GroceryOrdering,
  GrocerySendResult,
  KrogerStore,
  GroceryState,
  SetFavoriteRequest,
  StoreAvailability,
  UpdateFavoriteRequest,
} from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useSession } from '../../session';
import { openGroceryPopout } from './GroceryPopout';
import { count } from '../../format';

/** One household grocery list — one family, one grocery run. */
export default function Grocery() {
  const { viewing, me } = useSession();
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
    setMsg(
      `${count(r.meals, 'meal')} → ${r.added} added, ${r.merged} updated, ${r.skipped} already there, ` +
        `${r.removed} no longer needed, ${count(r.staples, 'staple')}`,
    );
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
                  onChange={(e) => void run(api<GroceryState>(`/api/grocery/items/${it.id}`, 'PATCH', { done: e.target.checked }))}
                />
                <span className="name">
                  {it.item} {it.qty && <span className="muted">{it.qty}</span>}
                </span>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => void run(api<GroceryState>(`/api/grocery/items/${it.id}`, 'DELETE'))}
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

      {me.member?.kind === 'adult' && <OrderIt key={data.items.filter((i) => !i.done).length} />}

      <Stores state={data} onChange={setData} />

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

/**
 * Hana step 3: send the list to a store. MyDay builds the Instacart list or
 * fills the Kroger cart; checking out and paying always happens on the store's
 * own site.
 */
function OrderIt() {
  const { data, setData, reload } = useLoad<GroceryOrdering>('/api/grocery/ordering');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<GrocerySendResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zip, setZip] = useState('');
  const [stores, setStores] = useState<KrogerStore[] | null>(null);
  const flash = new URLSearchParams(window.location.search).get('kroger');
  if (!data || (!data.instacart && !data.kroger.available)) return null;

  const go = async <T,>(p: Promise<T>): Promise<T | null> => {
    setBusy(true);
    setErr(null);
    try {
      return await p;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t go through');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const send = async (to: 'instacart' | 'kroger'): Promise<void> => {
    const r = await go(api<GrocerySendResult>(`/api/grocery/send/${to}`, 'POST'));
    if (r) setSent(r);
  };
  const connect = async (): Promise<void> => {
    const r = await go(api<{ url: string }>('/api/grocery/kroger/connect'));
    if (r) window.location.assign(r.url);
  };
  const findStores = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const r = await go(api<{ stores: KrogerStore[] }>(`/api/grocery/kroger/stores?zip=${encodeURIComponent(zip)}`));
    if (r) setStores(r.stores);
  };
  const pick = async (s: KrogerStore): Promise<void> => {
    if (await go(api('/api/grocery/kroger/store', 'PUT', { id: s.id, name: `${s.name}${s.address ? ` — ${s.address}` : ''}` }))) {
      setStores(null);
      reload();
    }
  };
  const disconnect = async (): Promise<void> => {
    if (await go(api('/api/grocery/kroger', 'DELETE'))) setData({ ...data, kroger: { ...data.kroger, connected: false, store: null } });
  };
  const empty = data.openItems === 0;

  return (
    <div className="card" data-testid="order-it">
      <h2>Order it</h2>
      <p className="muted small">MyDay sends the list over — you check out and pay on the store’s site. Or ask Hana: “order the groceries”.</p>
      {flash === 'connected' && <p className="pill">Kroger connected ✓</p>}
      {flash === 'failed' && <p className="error">Kroger didn’t finish connecting — try again.</p>}
      {empty && <p className="muted">Add something to the list first.</p>}
      {data.instacart && (
        <button className="btn" disabled={busy || empty} onClick={() => void send('instacart')} data-testid="send-instacart">
          Send to Instacart
        </button>
      )}
      {data.kroger.available && (
        <div className="kroger">
          {!data.kroger.connected ? (
            <button className="btn ghost" disabled={busy} onClick={() => void connect()} data-testid="kroger-connect">
              Connect Kroger
            </button>
          ) : (
            <>
              <p className="small">
                Kroger: <b>{data.kroger.store ?? 'pick your store'}</b>{' '}
                <button className="link danger" onClick={() => void disconnect()}>
                  Disconnect
                </button>
              </p>
              <form className="inline" onSubmit={(e) => void findStores(e)}>
                <input value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))} placeholder="ZIP for your store" inputMode="numeric" aria-label="ZIP for your Kroger store" />
                <button className="btn small ghost" disabled={busy || zip.length !== 5}>
                  Find stores
                </button>
              </form>
              {stores && (
                <ul className="plain rows" data-testid="kroger-stores">
                  {stores.length === 0 && <li className="muted">No Kroger stores near that ZIP.</li>}
                  {stores.map((s) => (
                    <li key={s.id}>
                      <span>
                        {s.name} <span className="muted small">{s.address}</span>
                      </span>
                      <button className="btn small" onClick={() => void pick(s)}>
                        Use this one
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {data.kroger.store && (
                <button className="btn" disabled={busy || empty} onClick={() => void send('kroger')} data-testid="send-kroger">
                  Fill my Kroger cart
                </button>
              )}
            </>
          )}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {sent && (
        <div className="sent" data-testid="order-sent">
          <p>
            {sent.added.length} item{sent.added.length === 1 ? '' : 's'} sent{sent.notFound.length ? ` · couldn’t find: ${sent.notFound.join(', ')}` : ''}.
          </p>
          <a className="btn" href={sent.url} target="_blank" rel="noopener noreferrer">
            {sent.provider === 'kroger' ? 'Check out at Kroger →' : 'Check out on Instacart →'}
          </a>
        </div>
      )}
    </div>
  );
}

const AVAIL: Record<StoreAvailability, string> = { advertised: '✓', check: 'check', no: '—' };

/** Household ZIP, my favorite stores (with pickup/delivery + signed-in), all stores. */
function Stores({ state, onChange }: { state: GroceryState; onChange: (s: GroceryState) => void }) {
  const [zip, setZip] = useState(state.zip);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const run = async (p: Promise<GroceryState>): Promise<void> => {
    try {
      onChange(await p);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const fav = (store: string): GroceryFavorite | undefined => state.favorites.find((f) => f.store === store);
  const chain = (store: string): GroceryChain | undefined => state.chains.find((c) => c.name === store);
  const near = (q: string): string => `https://www.google.com/maps/search/${encodeURIComponent(q)}+near+${encodeURIComponent(state.zip)}`;
  const setFav = (store: string, favorite: boolean): Promise<void> => {
    const body: SetFavoriteRequest = { store, favorite };
    return run(api<GroceryState>('/api/grocery/favorites', 'POST', body));
  };
  const update = (body: UpdateFavoriteRequest): Promise<void> => run(api<GroceryState>('/api/grocery/favorites', 'PATCH', body));
  const addStore = (e: FormEvent): void => {
    e.preventDefault();
    const body: AddCustomStoreRequest = { name, url };
    void run(api<GroceryState>('/api/grocery/stores', 'POST', body)).then(() => {
      setName('');
      setUrl('');
    });
  };

  return (
    <>
      <div className="card">
        <h2>Household ZIP</h2>
        <p className="muted">Used to find stores near you.</p>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api<GroceryState>('/api/grocery/zip', 'PUT', { zip }));
          }}
        >
          <input value={zip} onChange={(e) => setZip(e.target.value)} placeholder="ZIP" inputMode="numeric" maxLength={10} />
          <button className="btn small">Save ZIP</button>
        </form>
        {state.zip && (
          <a href={near('grocery stores')} target="_blank" rel="noreferrer">
            See all stores near {state.zip} →
          </a>
        )}
      </div>

      <div className="card" data-testid="order">
        <h2>Order your list</h2>
        <p className="muted small">
          One tap opens that store's own grocery ordering page. You place the order there — MyDay never orders or pays for anything.
        </p>
        <button
          className="btn small ghost"
          onClick={() => {
            const text = state.items.filter((i) => !i.done).map((i) => i.item).join('\n');
            void navigator.clipboard?.writeText(text).then(() => setErr('List copied — paste it into the store’s search.'));
          }}
        >
          Copy list
        </button>
        <div className="storebtns" style={{ marginTop: 8 }}>
          {[...state.chains]
            .filter((c) => c.orderUrl)
            .sort((a, b) => Number(!!fav(b.name)) - Number(!!fav(a.name)))
            .map((c) => (
              <a key={c.name} className={fav(c.name) ? 'btn small' : 'btn small ghost'} href={c.orderUrl ?? c.shopUrl} target="_blank" rel="noreferrer" data-testid="order-link">
                {fav(c.name) ? '★ ' : ''}
                {c.name}
              </a>
            ))}
        </div>
      </div>

      {state.favorites.length > 0 && (
        <div className="card" data-testid="favorites">
          <h2>My stores</h2>
          {state.favorites.map((f) => {
            const c = chain(f.store);
            return (
              <div key={f.store} className="fav">
                <div className="ex-head">
                  <b>{f.store}</b>
                  <button className="link danger" onClick={() => void setFav(f.store, false)}>
                    ★ Unfavorite
                  </button>
                </div>
                <div className="chips">
                  {(['instore', 'pickup', 'delivery'] as const).map((m) => (
                    <button key={m} className={f.fulfillment === m ? 'chip on' : 'chip'} onClick={() => void update({ store: f.store, fulfillment: m })}>
                      {m === 'instore' ? 'In store' : m === 'pickup' ? 'Pickup' : 'Delivery'}
                    </button>
                  ))}
                </div>
                <div className="chips">
                  {c && (
                    <a className="chip" href={c.shopUrl} target="_blank" rel="noreferrer">
                      Shop online
                    </a>
                  )}
                  {c && (
                    <a className="chip" href={c.acctUrl} target="_blank" rel="noreferrer">
                      Sign in
                    </a>
                  )}
                  <button className="chip" onClick={() => openGroceryPopout(f.store)}>
                    Side-by-side list
                  </button>
                  <button className={f.signedIn ? 'chip on' : 'chip'} onClick={() => void update({ store: f.store, signedIn: !f.signedIn })}>
                    {f.signedIn ? 'Signed in ✓' : 'Not signed in'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="card">
        <h2>Stores near {state.zip || 'you'}</h2>
        <p className="muted">Major chains plus your own. Availability and fees are set by the store, not MyDay.</p>
        <ul className="plain rows" data-testid="stores">
          {state.chains.map((c) => (
            <li key={c.name}>
              <span>
                <b>{c.name}</b>{' '}
                <small className="muted">
                  pickup {AVAIL[c.pickup]} · delivery {AVAIL[c.delivery]} · {c.note}
                </small>
              </span>
              <span>
                {state.zip && (
                  <a className="small-link" href={near(c.name)} target="_blank" rel="noreferrer">
                    Map
                  </a>
                )}{' '}
                <button className="link" aria-label={fav(c.name) ? 'Unfavorite' : 'Favorite'} onClick={() => void setFav(c.name, !fav(c.name))}>
                  {fav(c.name) ? '★' : '☆'}
                </button>
                {c.custom && (
                  <button className="link danger" onClick={() => void run(api<GroceryState>(`/api/grocery/stores/${encodeURIComponent(c.name)}`, 'DELETE'))}>
                    ✕
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <form className="inline" onSubmit={addStore}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your store" required />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="store website" required />
          <button className="btn small">Add</button>
        </form>
        {err && <p className="error">{err}</p>}
      </div>
    </>
  );
}
