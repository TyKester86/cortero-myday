import { useState } from 'react';
import { ASSET_CLASSES, INVEST_KIND_LABEL, INVEST_KINDS, type Allocation, type InvestAccount, type InvestKind, type InvestResponse } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { useSession } from '../../session';

const usd = (n: number): string => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const LABEL: Record<(typeof ASSET_CLASSES)[number], string> = { stocks: 'Stocks', bonds: 'Bonds', cash: 'Cash', other: 'Other' };

function MixInputs({ value, onChange }: { value: Allocation; onChange: (a: Allocation) => void }) {
  const sum = ASSET_CLASSES.reduce((s, c) => s + (Number(value[c]) || 0), 0);
  return (
    <div className="form wide">
      {ASSET_CLASSES.map((c) => (
        <label key={c} style={{ flex: '1 1 70px' }}>
          {LABEL[c]} %
          <input inputMode="decimal" value={value[c]} onChange={(e) => onChange({ ...value, [c]: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
        </label>
      ))}
      <small className={Math.abs(sum - 100) < 0.01 ? 'muted' : 'warn'}>adds to {sum}%</small>
    </div>
  );
}

function BalanceForm({ a, onSave }: { a: InvestAccount; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [balance, setBalance] = useState('');
  const [m, setM] = useState<Allocation>(a.asOf ? a.allocation : { stocks: 90, bonds: 10, cash: 0, other: 0 });
  return (
    <details>
      <summary>Update balance</summary>
      <div className="form">
        <input inputMode="decimal" placeholder="Balance today ($)" value={balance} onChange={(e) => setBalance(e.target.value)} aria-label={`${a.name} balance`} />
        <MixInputs value={m} onChange={setM} />
        <button
          className="btn small"
          disabled={!balance}
          onClick={() =>
            void onSave({ balance, stocksPct: m.stocks, bondsPct: m.bonds, cashPct: m.cash, otherPct: m.other }).then(() => setBalance(''))
          }
        >
          Save balance
        </button>
      </div>
    </details>
  );
}

/** Investments & retirement: manual accounts, target vs actual mix, and a simple projection (not advice). */
export default function Invest() {
  const confirm = useConfirm();
  const { members } = useSession();
  const { data, error, setData } = useLoad<InvestResponse>('/api/invest');
  const [acct, setAcct] = useState({ name: '', kind: '401k' as InvestKind, owner: '', monthlyContribution: '', employerMatch: '' });
  const [plan, setPlan] = useState<null | { target: Allocation; expectedReturnPct: number; inflationPct: number; yearsToRetire: number; withdrawalPct: number }>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const run = async (p: Promise<InvestResponse>, ok: string): Promise<void> => {
    try {
      setData(await p);
      setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const pl = plan ?? data.plan;
  const peak = Math.max(1, ...data.projection.map((p) => p.nominal));
  const step = Math.max(1, Math.ceil(data.projection.length / 12));
  const bars = data.projection.filter((p, i) => i % step === 0 || i === data.projection.length - 1);

  return (
    <section>
      <h1>Investments</h1>
      <div className="bigscore" data-testid="invest-total">
        <b>{usd(data.total)}</b>
        <span className="muted">across {data.accounts.length} account{data.accounts.length === 1 ? '' : 's'} · {usd(data.monthlyContributions)}/mo going in</span>
      </div>
      {msg && <p className="muted" role="status">{msg}</p>}

      <div className="card" data-testid="invest-accounts">
        <h2>Accounts</h2>
        {data.accounts.length === 0 && <p className="muted">Add your 401(k), IRA or brokerage account — typed in by hand, nothing linked.</p>}
        {data.accounts.map((a) => (
          <div key={a.id} className="quest">
            <span className="grow">
              <b>{a.name}</b>{' '}
              <small className="muted">
                {INVEST_KIND_LABEL[a.kind]}
                {a.owner && ` · ${a.owner}`} · {usd(a.balance)}
                {a.asOf ? ` as of ${a.asOf}` : ' · no balance yet'} · +{usd(a.monthlyContribution)}/mo
                {a.employerMatch > 0 && ` + ${usd(a.employerMatch)} match`}
              </small>
              <BalanceForm a={a} onSave={(body) => run(api(`/api/invest/accounts/${a.id}/balances`, 'POST', body), `${a.name} updated`)} />
            </span>
            <button
              className="link danger"
              aria-label={`Remove ${a.name}`}
              onClick={() =>
                void confirm({ title: `Remove ${a.name}?`, body: 'Its balance history goes with it.', confirmLabel: 'Remove', danger: true }).then(
                  (y) => void (y && run(api(`/api/invest/accounts/${a.id}`, 'DELETE'), 'Removed')),
                )
              }
            >
              ✕
            </button>
          </div>
        ))}
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api('/api/invest/accounts', 'POST', { ...acct, owner: acct.owner || null }), 'Account added').then(() =>
              setAcct({ ...acct, name: '', monthlyContribution: '', employerMatch: '' }),
            );
          }}
        >
          <input value={acct.name} onChange={(e) => setAcct({ ...acct, name: e.target.value })} placeholder="Account name" required />
          <select value={acct.kind} onChange={(e) => setAcct({ ...acct, kind: e.target.value as InvestKind })} aria-label="Type">
            {INVEST_KINDS.map((k) => (
              <option key={k} value={k}>
                {INVEST_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select value={acct.owner} onChange={(e) => setAcct({ ...acct, owner: e.target.value })} aria-label="Whose">
            <option value="">Shared</option>
            {members
              .filter((m) => m.kind === 'adult')
              .map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
          </select>
          <input value={acct.monthlyContribution} onChange={(e) => setAcct({ ...acct, monthlyContribution: e.target.value })} placeholder="$/mo you add" inputMode="decimal" />
          <input value={acct.employerMatch} onChange={(e) => setAcct({ ...acct, employerMatch: e.target.value })} placeholder="$/mo match" inputMode="decimal" />
          <button className="btn small">Add</button>
        </form>
      </div>

      <div className="card" data-testid="invest-mix">
        <h2>Mix: target vs actual</h2>
        {ASSET_CLASSES.map((c) => (
          <div key={c} className="quest">
            <span style={{ width: 60 }}>{LABEL[c]}</span>
            <span className="grow">
              <div className="bar">
                <i style={{ width: `${data.actual[c]}%` }} />
              </div>
              <small className="muted">
                actual {data.actual[c]}% · target {data.plan.target[c]}%
              </small>
            </span>
            <span className={Math.abs(data.drift[c]) > 5 ? 'pill sun' : 'pill'}>
              {data.drift[c] > 0 ? '+' : ''}
              {data.drift[c]} pts
            </span>
          </div>
        ))}
        <p className="muted small">More than 5 points off target is flagged — a nudge to rebalance, not an alarm.</p>
      </div>

      <div className="card" data-testid="invest-projection">
        <h2>Where this could go</h2>
        <p className="small">
          In {data.plan.yearsToRetire} years at {data.plan.expectedReturnPct}%/yr: <b>{usd(data.atRetirement.nominal)}</b> (about <b>{usd(data.atRetirement.real)}</b> in today’s money) — roughly{' '}
          <b>{usd(data.atRetirement.yearlyIncomeReal)}/yr</b> at a {data.plan.withdrawalPct}% withdrawal.
        </p>
        <div className="spark" style={{ height: 90 }} aria-label="Projected balance by year">
          {bars.map((p) => (
            <i key={p.year} className={p.year === data.plan.yearsToRetire ? 'hot' : ''} style={{ height: `${Math.max(2, (p.nominal / peak) * 100)}%` }} title={`Year ${p.year}: ${usd(p.nominal)}`} />
          ))}
        </div>
        <p className="muted small">A planning sketch, not financial advice: steady returns, contributions held flat, no taxes or fees.</p>
        <details>
          <summary>Change targets and assumptions</summary>
          <div className="form">
            <MixInputs value={pl.target} onChange={(t) => setPlan({ ...pl, target: t })} />
            <div className="form wide">
              <label>
                Return %/yr
                <input inputMode="decimal" value={pl.expectedReturnPct} onChange={(e) => setPlan({ ...pl, expectedReturnPct: Number(e.target.value) || 0 })} />
              </label>
              <label>
                Inflation %
                <input inputMode="decimal" value={pl.inflationPct} onChange={(e) => setPlan({ ...pl, inflationPct: Number(e.target.value) || 0 })} />
              </label>
              <label>
                Years to retire
                <input inputMode="numeric" value={pl.yearsToRetire} onChange={(e) => setPlan({ ...pl, yearsToRetire: Number(e.target.value) || 1 })} />
              </label>
              <label>
                Withdrawal %
                <input inputMode="decimal" value={pl.withdrawalPct} onChange={(e) => setPlan({ ...pl, withdrawalPct: Number(e.target.value) || 4 })} />
              </label>
            </div>
            <button
              className="btn small"
              onClick={() =>
                void run(
                  api('/api/invest/plan', 'PUT', {
                    targetStocks: pl.target.stocks,
                    targetBonds: pl.target.bonds,
                    targetCash: pl.target.cash,
                    targetOther: pl.target.other,
                    expectedReturnPct: pl.expectedReturnPct,
                    inflationPct: pl.inflationPct,
                    yearsToRetire: pl.yearsToRetire,
                    withdrawalPct: pl.withdrawalPct,
                  }),
                  'Plan saved',
                ).then(() => setPlan(null))
              }
            >
              Save plan
            </button>
          </div>
        </details>
      </div>
    </section>
  );
}
