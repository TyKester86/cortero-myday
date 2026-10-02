import { useState } from 'react';
import type { BillsResponse } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';

const usd = (n: number): string => n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });

/** Manual money: bills (autopilot %), income, what's left, and the money check-in. No bank needed. */
export default function Bills() {
  const confirm = useConfirm();
  const { data, error, setData } = useLoad<BillsResponse>('/api/bills');
  const [bill, setBill] = useState({ name: '', amount: '', dueDay: '', autopay: false });
  const [inc, setInc] = useState({ source: '', amount: '' });
  const [anxiety, setAnxiety] = useState('Low');
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const run = async (p: Promise<BillsResponse>, ok: string): Promise<void> => {
    try {
      setData(await p);
      setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };

  return (
    <section>
      <h1>Bills & income</h1>
      <div className="stats">
        <div className="stat">
          <b data-testid="bills-left">{usd(data.left)}</b>
          <small>left each month</small>
        </div>
        <div className="stat">
          <b>{data.autopilot}%</b>
          <small>on autopilot</small>
        </div>
      </div>
      {msg && <p className="muted" role="status">{msg}</p>}

      {data.dueSoon.length > 0 && (
        <div className="card">
          <h2>Coming up this week</h2>
          <ul className="plain small">
            {data.dueSoon.map((d) => (
              <li key={`${d.name}${d.date}`}>
                {d.date} · {d.name} · {usd(d.amount)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card" data-testid="money-checkin">
        <h2>Money check-in</h2>
        <p className="small muted">Just looking is the win.</p>
        <div className="row">
          <select value={anxiety} onChange={(e) => setAnxiety(e.target.value)} aria-label="Money anxiety">
            <option>Low</option>
            <option>Medium</option>
            <option>High</option>
          </select>
          <button className="btn small" onClick={() => void run(api('/api/money/checkin', 'POST', { anxiety }), 'Logged — nice work looking ✓')}>
            I looked ✓
          </button>
        </div>
        {data.lastCheck && (
          <p className="muted small">
            Last check-in {data.lastCheck.date} · anxiety {data.lastCheck.anxiety}
          </p>
        )}
      </div>

      <div className="card" data-testid="bills">
        <h2>Bills · {usd(data.totalBills)}/mo</h2>
        <ul className="plain rows">
          {data.bills.map((b) => (
            <li key={b.id}>
              <span className="grow">
                {b.name} <small className="muted">{usd(b.amount)}{b.dueDay ? ` · due the ${b.dueDay}` : ''}</small>
              </span>
              <label className="small">
                <input type="checkbox" checked={b.autopay} onChange={(e) => void run(api(`/api/bills/${b.id}`, 'PATCH', { autopay: e.target.checked }), 'Saved ✓')} /> autopay
              </label>
              <button
                className="link danger"
                aria-label={`Remove ${b.name}`}
                onClick={() =>
                  void confirm({ title: `Stop tracking ${b.name}?`, confirmLabel: 'Remove', danger: true }).then((y) => void (y && run(api(`/api/bills/${b.id}`, 'DELETE'), 'Removed')))
                }
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api('/api/bills', 'POST', { ...bill, dueDay: bill.dueDay ? Number(bill.dueDay) : null }), 'Bill added ✓').then(() => setBill({ name: '', amount: '', dueDay: '', autopay: false }));
          }}
        >
          <input value={bill.name} onChange={(e) => setBill({ ...bill, name: e.target.value })} placeholder="Bill" required />
          <input value={bill.amount} onChange={(e) => setBill({ ...bill, amount: e.target.value })} placeholder="$" inputMode="decimal" required />
          <input value={bill.dueDay} onChange={(e) => setBill({ ...bill, dueDay: e.target.value.replace(/\D/g, '').slice(0, 2) })} placeholder="Due day" inputMode="numeric" />
          <label className="small inline-label">
            <input type="checkbox" checked={bill.autopay} onChange={(e) => setBill({ ...bill, autopay: e.target.checked })} /> autopay
          </label>
          <button className="btn small">Add</button>
        </form>
      </div>

      <div className="card" data-testid="income">
        <h2>Income · {usd(data.totalIncome)}/mo</h2>
        <ul className="plain rows">
          {data.income.map((i) => (
            <li key={i.id}>
              <span>
                {i.source} <small className="muted">{usd(i.amount)}</small>
              </span>
              <button
                className="link danger"
                aria-label={`Remove ${i.source}`}
                onClick={() =>
                  void confirm({ title: `Remove ${i.source}?`, confirmLabel: 'Remove', danger: true }).then((y) => void (y && run(api(`/api/income/${i.id}`, 'DELETE'), 'Removed')))
                }
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api('/api/income', 'POST', inc), 'Income added ✓').then(() => setInc({ source: '', amount: '' }));
          }}
        >
          <input value={inc.source} onChange={(e) => setInc({ ...inc, source: e.target.value })} placeholder="Source" required />
          <input value={inc.amount} onChange={(e) => setInc({ ...inc, amount: e.target.value })} placeholder="$ per month" inputMode="decimal" required />
          <button className="btn small">Add</button>
        </form>
      </div>
    </section>
  );
}
