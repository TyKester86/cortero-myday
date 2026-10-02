import { useState } from 'react';
import type { ExchangeRequest, LinkTokenResponse, MoneyResponse, MoneyTransaction } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useToast } from '../../components/useToast';

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

function loadPlaid(): Promise<PlaidGlobal> {
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
          · {t.date} · {t.accountName}
          {t.pending && ' · pending'}
        </small>
      </span>
      <b className={inflow ? 'good' : ''}>{inflow ? `+${usd(-t.amount)}` : `−${usd(t.amount)}`}</b>
    </li>
  );
}

/** Read-only money view: balances, safe to spend, subscription radar, transactions. */
export default function Money() {
  const { data, error, setData } = useLoad<MoneyResponse>('/api/money');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<MoneyTransaction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast, show } = useToast();

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

  if (data.provider === 'none') {
    return (
      <section>
        <h1>Money</h1>
        <p className="muted">Money isn't set up on this server yet — a grown-up needs to add the bank connection keys.</p>
      </section>
    );
  }

  const s = data.safeToSpend;
  return (
    <section>
      <h1>Money</h1>
      {data.provider === 'fake' && <p className="warn small">Demo data — not a real bank.</p>}
      {data.items.length === 0 ? (
        <div className="card">
          <p>Link your bank to see balances, what's safe to spend, and every subscription you're paying for. MyDay can only read — it can never move money.</p>
          <button className="btn" disabled={busy} onClick={() => void link()}>
            Link a bank
          </button>
        </div>
      ) : (
        <>
          {s && (
            <div className="bigscore" data-testid="safe-to-spend">
              <b>{usd(s.amount)}</b>
              <small>
                safe to spend until {s.until} ({s.basis === 'paycheck' ? 'next paycheck' : 'next 2 weeks'})
              </small>
            </div>
          )}
          {s && s.upcoming.length > 0 && (
            <div className="card">
              <h2>Coming out before then</h2>
              <ul className="plain rows">
                {s.upcoming.map((u, i) => (
                  <li key={`${u.merchant}${i}`}>
                    <span>
                      {u.merchant} <small className="muted">· {u.date}</small>
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
                      · {i.syncError || (i.lastSyncedAt ? `synced ${new Date(i.lastSyncedAt).toLocaleString()}` : 'not synced')}
                    </small>
                  </span>
                  <button
                    className="link danger"
                    onClick={() =>
                      confirm(`Unlink ${i.institution}? Its stored balances and transactions are deleted.`) &&
                      void run(api<MoneyResponse>(`/api/money/items/${i.id}`, 'DELETE'), 'Unlinked')
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
