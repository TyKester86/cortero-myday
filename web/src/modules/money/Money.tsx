import { useState } from 'react';
import type { BillsResponse, ExchangeRequest, LinkTokenResponse, MoneyResponse, MoneyTransaction } from '@myday/shared';
import { NavIcon } from '../../components/NavIcon';
import { useSession } from '../../session';
import { api, useLoad } from '../../api';
import { useToast } from '../../components/useToast';
import { useConfirm } from '../../components/Confirm';
import { ago, day } from '../../dates';
import { Link } from 'react-router';

const usd = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Plaid Link (loaded from Plaid's CDN only when real keys are configured). */
interface PlaidLinkHandler {
  open: () => void;
}
interface PlaidGlobal {
  create: (opts: {
    token: string;
    onSuccess: (publicToken: string, metadata: { institution?: { name?: string } | null }) => void;
    onExit?: () => void;
  }) => PlaidLinkHandler;
}
declare global {
  interface Window {
    Plaid?: PlaidGlobal;
  }
}

export function loadPlaid(): Promise<PlaidGlobal> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    s.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error('Plaid failed to load')));
    s.onerror = () => reject(new Error('Plaid failed to load'));
    document.head.appendChild(s);
  });
}

function Txn({ t }: { t: MoneyTransaction }) {
  const inflow = t.amount < 0;
  return (
    <li>
      <span>
        {t.merchant || t.name}
        <small className="muted">
          {' '}
          · {day(t.date)} · {t.accountName}
          {t.pending && ' · pending'}
        </small>
      </span>
      <b className={inflow ? 'good' : ''}>{inflow ? `+${usd(-t.amount)}` : `−${usd(t.amount)}`}</b>
    </li>
  );
}

/** Read-only money view: balances, safe to spend, subscription radar, transactions. */
/** A bill's line icon, from its name (rent, power, internet, phone, insurance, …). */
function billIcon(name: string): string {
  const n = name.toLowerCase();
  if (/rent|mortgage|hoa|home|house/.test(n)) return 'house';
  if (/electric|power|energy|gas|utility|water/.test(n)) return 'bolt';
  if (/card|loan|credit/.test(n)) return 'card';
  return 'receipt';
}

/** The next date a monthly bill falls due (from its day of the month). */
function nextDue(dueDay: number | null): Date | null {
  if (!dueDay) return null;
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), Math.min(dueDay, 28));
  if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d.setMonth(d.getMonth() + 1);
  return d;
}

/** Bills (they work without a bank), as row cards: icon, name, due date, amount. */
function BillRows({ bills }: { bills: BillsResponse | null }) {
  if (!bills) return null;
  const rows = bills.bills
    .map((b) => ({ b, due: nextDue(b.dueDay) }))
    .sort((x, y) => (x.due?.getTime() ?? Infinity) - (y.due?.getTime() ?? Infinity))
    .slice(0, 5);
  return (
    <>
      <h2 className="eyebrow">Bills</h2>
      <ul className="row-list" data-testid="money-bills">
        {rows.map(({ b, due }) => (
          <li key={b.id}>
            <Link to="/bills" className="row-card">
              <span className="row-icon">
                <NavIcon name={billIcon(b.name)} />
              </span>
              <span>
                <b className="row-title">{b.name}</b>
                <span className="row-sub">
                  {due ? `Due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'No due day set'}
                  {b.autopay ? ' • Autopay' : ''}
                </span>
              </span>
              <span className="row-trail">{Number.isInteger(b.amount) ? `$${b.amount.toLocaleString('en-US')}` : usd(b.amount)}</span>
            </Link>
          </li>
        ))}
        {!rows.length && (
          <li className="muted small">
            No bills yet. <Link to="/bills">Add the ones that repeat →</Link>
          </li>
        )}
      </ul>
    </>
  );
}

/** The next 14 days: today's checking balance minus what's coming out, day by day. */
function Forecast({ checking, upcoming }: { checking: number; upcoming: Array<{ date: string; amount: number }> }) {
  const start = new Date();
  const pts: number[] = [];
  let bal = checking;
  for (let i = 0; i < 14; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    bal -= upcoming.filter((u) => u.date === key).reduce((n, u) => n + u.amount, 0);
    pts.push(bal);
  }
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const y = (v: number): number => 80 - ((v - lo) / (hi - lo || 1)) * 60;
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${((i / 13) * 300).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 13);
  return (
    <>
      <h2 className="eyebrow">Forecast</h2>
      <div className="card forecast" data-testid="money-forecast">
        <small>Next 14 days</small>
        <svg viewBox="0 0 300 90" preserveAspectRatio="none" role="img" aria-label="Projected checking balance over the next 14 days">
          <path className="fc-fill" d={`${line} L300,90 L0,90 Z`} />
          <path className="fc-line" d={line} />
        </svg>
        <p>
          Projected balance on {end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ~{usd(pts[13] ?? checking)}
        </p>
      </div>
    </>
  );
}

export default function Money() {
  const { me } = useSession();
  const { data, error, setData } = useLoad<MoneyResponse>('/api/money');
  const bills = useLoad<BillsResponse>('/api/bills');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<MoneyTransaction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast, show } = useToast();
  const confirm = useConfirm();

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const run = async (p: Promise<MoneyResponse>, msg: string): Promise<void> => {
    setBusy(true);
    try {
      setData(await p);
      show(msg);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const link = async (): Promise<void> => {
    const { provider, linkToken } = await api<LinkTokenResponse>('/api/money/link-token', 'POST');
    if (provider === 'fake') {
      // Local proof: the fake provider skips Plaid's UI.
      const body: ExchangeRequest = { publicToken: `public-fake-${linkToken.slice(-6)}`, institution: 'Demo Bank (fake)' };
      await run(api<MoneyResponse>('/api/money/exchange', 'POST', body), 'Demo bank linked');
      return;
    }
    const Plaid = await loadPlaid();
    Plaid.create({
      token: linkToken,
      onSuccess: (publicToken, meta) => {
        const body: ExchangeRequest = { publicToken, institution: meta.institution?.name ?? 'Bank' };
        void run(api<MoneyResponse>('/api/money/exchange', 'POST', body), 'Bank linked');
      },
    }).open();
  };

  const search = async (): Promise<void> => {
    const r = await api<{ transactions: MoneyTransaction[] }>(`/api/money/transactions?days=120&q=${encodeURIComponent(q)}`);
    setFound(r.transactions);
  };

  const s = data.safeToSpend;
  const synced = data.items.map((i) => i.lastSyncedAt).filter(Boolean).sort().at(-1) ?? null;
  const head = (
    <>
      <header className="page-head">
        <h1 className="page-title">Money</h1>
        <p className="money-meta">
          {[me.household?.name, new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), synced ? `Updated ${ago(synced)}` : null].filter(Boolean).join(' · ')}
        </p>
      </header>
      <div className="sage-card money-hero" data-testid={s ? 'safe-to-spend' : 'safe-to-spend-empty'}>
        <span className="label">Safe to spend</span>
        <div className="sage-big">{s ? usd(s.amount) : '—'}</div>
        <span>
          {s
            ? `Available until ${new Date(`${s.until}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} (${s.basis === 'paycheck' ? 'next paycheck' : 'next 2 weeks'}), after bills`
            : data.provider === 'none'
              ? 'Bank connections aren’t switched on yet — bills still work.'
              : 'Link a bank to see what’s safe to spend.'}
        </span>
        <span className="wallet" aria-hidden="true">
          <NavIcon name="money" size={24} />
        </span>
      </div>
      <BillRows bills={bills.data} />
      {s && <Forecast checking={s.checking} upcoming={s.upcoming} />}
    </>
  );

  if (data.provider === 'none') {
    return (
      <section className="money">
        {head}
        <p className="muted small">Money isn't set up on this server yet — a grown-up needs to add the bank connection keys.</p>
      </section>
    );
  }

  return (
    <section className="money">
      {head}
      {data.provider === 'fake' && <p className="warn small">Demo data — not a real bank.</p>}
      {data.items.length === 0 ? (
        <div className="card" data-testid="money-empty">
          <h2>See your money in one calm place</h2>
          <ul className="plain small">
            <li>✓ What’s safe to spend until the next paycheck</li>
            <li>✓ Every subscription you’re paying for — and the ones you forgot</li>
            <li>✓ Bills coming up, so nothing sneaks up on you</li>
          </ul>
          <p className="small muted">MyDay can only read — it can never move money. You can unlink any time.</p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => void link()}>
              Link a bank
            </button>
            <Link className="btn ghost" to="/bills">
              Just track bills
            </Link>
          </div>
        </div>
      ) : (
        <>
          {s && s.upcoming.length > 0 && (
            <div className="card">
              <h2>Coming out before then</h2>
              <ul className="plain rows">
                {s.upcoming.map((u, i) => (
                  <li key={`${u.merchant}${i}`}>
                    <span>
                      {u.merchant} <small className="muted">· {day(u.date)}</small>
                    </span>
                    <b>−{usd(u.amount)}</b>
                  </li>
                ))}
              </ul>
              <small className="muted">Checking now: {usd(s.checking)}</small>
            </div>
          )}

          <div className="card">
            <h2>Accounts</h2>
            <ul className="plain rows">
              {data.accounts.map((a) => (
                <li key={a.id}>
                  <span>
                    {a.name} <small className="muted">··{a.mask} · {a.institution}</small>
                  </span>
                  <b>{usd((a.type === 'credit' ? -1 : 1) * (a.current ?? 0))}</b>
                </li>
              ))}
            </ul>
          </div>

          <div className="card" data-testid="subscriptions">
            <h2>📡 Subscription radar</h2>
            {data.subscriptions.length === 0 ? (
              <p className="muted">No repeating charges found yet.</p>
            ) : (
              <>
                <ul className="plain rows">
                  {data.subscriptions.map((r) => (
                    <li key={r.merchant}>
                      <span>
                        {r.merchant}
                        <small className="muted">
                          {' '}
                          · {r.cadence} · next {r.nextDate}
                        </small>
                      </span>
                      <b>{usd(r.amount)}</b>
                    </li>
                  ))}
                </ul>
                <small className="muted">≈ {usd(data.subscriptions.reduce((t, r) => t + r.monthly, 0))} a month</small>
              </>
            )}
          </div>

          {data.income.length > 0 && (
            <div className="card">
              <h2>Paychecks</h2>
              <ul className="plain rows">
                {data.income.map((r) => (
                  <li key={r.merchant}>
                    <span>
                      {r.merchant} <small className="muted">· {r.cadence} · next {r.nextDate}</small>
                    </span>
                    <b className="good">+{usd(r.amount)}</b>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card">
            <h2>Transactions</h2>
            <form
              className="inline"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search (e.g. Kroger)" />
              <button className="btn small">Search</button>
            </form>
            <ul className="plain rows">
              {(found ?? data.transactions).map((t) => (
                <Txn key={t.id} t={t} />
              ))}
            </ul>
          </div>

          <div className="card">
            <h2>Linked banks</h2>
            <ul className="plain rows">
              {data.items.map((i) => (
                <li key={i.id}>
                  <span>
                    {i.institution}
                    <small className={i.syncError ? 'warn' : 'muted'}>
                      {' '}
                      · {i.syncError || (i.lastSyncedAt ? `synced ${ago(i.lastSyncedAt)}` : 'not synced')}
                    </small>
                  </span>
                  <button
                    className="link danger"
                    onClick={() =>
                      void confirm({
                        title: `Unlink ${i.institution}?`,
                        body: 'Its stored balances and transactions are deleted from MyDay.',
                        confirmLabel: 'Unlink',
                        danger: true,
                      }).then((ok) => { if (ok) void run(api<MoneyResponse>(`/api/money/items/${i.id}`, 'DELETE'), 'Unlinked'); })
                    }
                  >
                    Unlink
                  </button>
                </li>
              ))}
            </ul>
            <button className="btn small" disabled={busy} onClick={() => void run(api<MoneyResponse>('/api/money/sync', 'POST'), 'Synced')}>
              Sync now
            </button>{' '}
            <button className="link" disabled={busy} onClick={() => void link()}>
              Link another bank
            </button>
          </div>
        </>
      )}
      {toast}
    </section>
  );
}
