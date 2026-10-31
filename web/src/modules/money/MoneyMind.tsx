import { useState } from 'react';
import type { MoneyAccount, MoneyMind, MindDebts } from '@myday/shared';
import { api } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { day } from '../../dates';

const usd = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const month = (ym: string | null): string => (ym ? new Date(`${ym}-15T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : 'never at this pace');
const STRATEGY = { avalanche: 'Avalanche (highest APR first)', snowball: 'Snowball (smallest balance first)', minimums: 'Minimums only' } as const;

/**
 * Q6: Hana's money mind on the Money page — what's committed, the dip ahead with its prepared fix,
 * the month on the pay rhythm, every debt with the plans side by side, sinking funds, the 24-hour
 * list and the capture checks. She prepares; a grown-up does every payment and transfer.
 */
export function MoneyMindPanel({ mind, setMind, cards }: { mind: MoneyMind; setMind: (m: MoneyMind) => void; cards: MoneyAccount[] }) {
  const confirm = useConfirm();
  const [msg, setMsg] = useState<string | null>(null);
  const [debt, setDebt] = useState({ name: '', kind: 'credit_card', balance: '', apr: '', minimum: '', dueDay: '', limit: '', accountId: '' });
  const [fund, setFund] = useState({ name: '', amount: '', dueOn: '', saved: '' });
  const [want, setWant] = useState({ what: '', amount: '' });
  const [benefit, setBenefit] = useState({ kind: 'fsa', label: '', amount: '', deadline: '' });
  const [extra, setExtra] = useState(String(mind.debts.extra || ''));
  const [plan, setPlan] = useState<MindDebts | null>(null);
  const s = mind.settings;
  const [pay, setPay] = useState({ payAnchor: s.payAnchor ?? '', payCadence: s.payCadence ?? '', payAmount: s.payAmount ? String(s.payAmount) : '', cushion: String(s.cushion), wantThreshold: String(s.wantThreshold) });
  const run = async (p: Promise<MoneyMind>, ok: string): Promise<boolean> => {
    try {
      setMind(await p);
      setPlan(null);
      setMsg(ok);
      return true;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
      return false;
    }
  };
  const d = plan ?? mind.debts;
  const open = mind.wants.filter((w) => !w.decided);

  return (
    <div className="money-mind" data-testid="money-mind">
      {msg && (
        <p className="small" role="status">
          {msg}
        </p>
      )}

      {mind.overdraft && (
        <div className="card warn-card" data-testid="mind-overdraft">
          <h2>A dip ahead — fixable now</h2>
          <p>
            {mind.overdraft.account} goes to <b>{usd(mind.overdraft.low)}</b> on {day(mind.overdraft.date)} unless {usd(mind.overdraft.shortBy)} moves.
          </p>
          <p>
            <b>Prepared fix:</b> {mind.overdraft.fix}
          </p>
          <small className="muted">You make the move — MyDay never moves money. Assumes: {mind.overdraft.assumptions.join(' ')}</small>
        </div>
      )}

      {mind.safe && mind.safe.committed.length > 0 && (
        <div className="card" data-testid="mind-committed">
          <h2>Already promised before {day(mind.safe.until)}</h2>
          <ul className="plain rows">
            {mind.safe.committed.map((c, i) => (
              <li key={`${c.what}${i}`}>
                <span>
                  {c.what} <small className="muted">· {c.kind === 'reserve' ? 'set aside' : day(c.date)}</small>
                </span>
                <b>−{usd(c.amount)}</b>
              </li>
            ))}
          </ul>
          <small className="muted">
            {usd(mind.safe.cash)} in checking − {usd(mind.safe.committedTotal)} = {usd(mind.safe.amount)} safe to spend.
            {mind.safe.onCards.length > 0 && ` On cards (moves the card balance, not checking): ${mind.safe.onCards.map((c) => `${c.merchant} ${usd(c.amount)}`).join(', ')}.`}
          </small>
        </div>
      )}

      {mind.wins.length > 0 && (
        <div className="card" data-testid="mind-wins">
          <h2>Wins</h2>
          <ul className="plain">
            {mind.wins.map((w) => (
              <li key={w}>✓ {w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card" data-testid="mind-rhythm">
        <h2>The month on your pay rhythm</h2>
        {mind.choreography.note && <p className="muted small">{mind.choreography.note}</p>}
        {mind.choreography.periods.length > 0 && (
          <ul className="plain rows">
            {mind.choreography.periods.map((p) => (
              <li key={p.start} className={p.tight ? 'tight' : ''}>
                <span>
                  {day(p.start)} – {day(p.end)} <small className="muted">· {usd(p.income)} {p.incomeLabel} − {usd(p.total)} due</small>
                </span>
                <b className={p.tight ? 'bad' : 'good'}>{usd(p.net)}</b>
              </li>
            ))}
          </ul>
        )}
        {mind.choreography.moves.map((m) => (
          <p key={m.what + m.from} className="small">
            <b>Drafted move — {m.what}:</b> {m.why} <span className="muted">(a call or a setting on their site; you make it)</span>
          </p>
        ))}
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api('/api/money/settings', 'PUT', { ...pay, payCadence: pay.payCadence || null, payAnchor: pay.payAnchor || null, payAmount: pay.payAmount || null }), 'Saved ✓');
          }}
        >
          <input type="date" value={pay.payAnchor} onChange={(e) => setPay({ ...pay, payAnchor: e.target.value })} aria-label="A payday" />
          <select value={pay.payCadence} onChange={(e) => setPay({ ...pay, payCadence: e.target.value })} aria-label="How often">
            <option value="">Paid…</option>
            <option value="weekly">weekly</option>
            <option value="biweekly">every 2 weeks</option>
            <option value="semimonthly">twice a month</option>
            <option value="monthly">monthly</option>
          </select>
          <input value={pay.payAmount} onChange={(e) => setPay({ ...pay, payAmount: e.target.value })} placeholder="Take-home $" inputMode="decimal" />
          <input value={pay.cushion} onChange={(e) => setPay({ ...pay, cushion: e.target.value })} placeholder="Cushion $" inputMode="decimal" aria-label="Keep at least this in checking" />
          <input value={pay.wantThreshold} onChange={(e) => setPay({ ...pay, wantThreshold: e.target.value })} placeholder="Hold buys over $" inputMode="decimal" aria-label="Hold non-essential buys over" />
          <button className="btn small">Save</button>
        </form>
        <small className="muted">The pay schedule is used when the bank doesn’t show a paycheck yet.</small>
      </div>

      <div className="card" data-testid="mind-debts">
        <h2>Debts</h2>
        {d.debts.length === 0 ? (
          <p className="muted">No debts on the list. Add cards and loans to see every one in one picture.</p>
        ) : (
          <>
            <ul className="plain rows">
              {d.debts.map((x) => (
                <li key={`${x.id ?? 'card'}-${x.name}`}>
                  <span>
                    {x.name}
                    <small className="muted">
                      {' '}
                      · {x.apr !== null ? `${x.apr}% APR` : 'APR not entered'} · min {usd(x.minimum)}
                      {x.nextDue && ` due ${day(x.nextDue)}`}
                      {x.utilization !== null && ` · ${x.utilization}% of limit`}
                    </small>
                  </span>
                  <b>{usd(x.balance)}</b>
                  {x.id !== null && (
                    <button
                      className="btn ghost small"
                      aria-label={`Remove ${x.name}`}
                      onClick={() =>
                        void confirm({ title: `Remove ${x.name}?`, confirmLabel: 'Remove', danger: true }).then((y) => void (y && run(api(`/api/money/debts/${x.id}`, 'DELETE'), 'Removed')))
                      }
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <p className="small">
              {usd(d.total)} total · {usd(d.minimums)} a month in minimums
            </p>
            {d.warnings.map((w) => (
              <p key={w} className="warn small">
                {w}
              </p>
            ))}
            <form
              className="form wide"
              onSubmit={(e) => {
                e.preventDefault();
                void api<MindDebts>(`/api/money/payoff?extra=${encodeURIComponent(extra || '0')}`).then(setPlan, (err: unknown) => setMsg(err instanceof Error ? err.message : 'Could not model it'));
              }}
            >
              <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Extra $ a month" inputMode="decimal" aria-label="Extra a month toward debt" />
              <button className="btn small">Model it</button>
              <button type="button" className="btn ghost small" onClick={() => void run(api('/api/money/settings', 'PUT', { extraPayment: extra || 0 }), 'Plan saved ✓')}>
                Keep this extra
              </button>
            </form>
            <table className="mind-plans" data-testid="mind-plans">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Debt-free</th>
                  <th>Interest</th>
                  <th>Saved</th>
                </tr>
              </thead>
              <tbody>
                {d.plans.map((p) => (
                  <tr key={p.strategy} className={d.recommended === p.strategy ? 'recommended' : ''}>
                    <td>{STRATEGY[p.strategy]}</td>
                    <td>{month(p.debtFree)}</td>
                    <td>{p.interest === null ? '—' : usd(p.interest)}</td>
                    <td>{p.saved ? usd(p.saved) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.why && <p className="small">{d.why}</p>}
            <small className="muted">{d.assumptions.join(' ')}</small>
          </>
        )}
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api('/api/money/debts', 'POST', { ...debt, apr: debt.apr || null, limit: debt.limit || null, dueDay: debt.dueDay || null, accountId: debt.accountId || null }), 'Debt added ✓').then(
              (ok) => ok && setDebt({ name: '', kind: 'credit_card', balance: '', apr: '', minimum: '', dueDay: '', limit: '', accountId: '' }),
            );
          }}
        >
          <input value={debt.name} onChange={(e) => setDebt({ ...debt, name: e.target.value })} placeholder="Name (Visa, car loan…)" required />
          <select value={debt.kind} onChange={(e) => setDebt({ ...debt, kind: e.target.value })} aria-label="Kind">
            <option value="credit_card">Card</option>
            <option value="auto">Car</option>
            <option value="student">Student</option>
            <option value="mortgage">Mortgage</option>
            <option value="personal">Personal</option>
            <option value="medical">Medical</option>
            <option value="other">Other</option>
          </select>
          {cards.length > 0 && debt.kind === 'credit_card' && (
            <select value={debt.accountId} onChange={(e) => setDebt({ ...debt, accountId: e.target.value })} aria-label="Linked card">
              <option value="">Not linked</option>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ··{c.mask}
                </option>
              ))}
            </select>
          )}
          {!debt.accountId && <input value={debt.balance} onChange={(e) => setDebt({ ...debt, balance: e.target.value })} placeholder="Balance $" inputMode="decimal" />}
          <input value={debt.apr} onChange={(e) => setDebt({ ...debt, apr: e.target.value })} placeholder="APR %" inputMode="decimal" />
          <input value={debt.minimum} onChange={(e) => setDebt({ ...debt, minimum: e.target.value })} placeholder="Minimum $" inputMode="decimal" />
          <input value={debt.dueDay} onChange={(e) => setDebt({ ...debt, dueDay: e.target.value.replace(/\D/g, '').slice(0, 2) })} placeholder="Due day" inputMode="numeric" />
          {!debt.accountId && <input value={debt.limit} onChange={(e) => setDebt({ ...debt, limit: e.target.value })} placeholder="Limit $" inputMode="decimal" />}
          <button className="btn small">Add</button>
        </form>
      </div>

      <div className="card" data-testid="mind-funds">
        <h2>Sinking funds</h2>
        <p className="small muted">The irregular costs, turned into a monthly set-aside — so they stop arriving as surprises. Safe to spend already holds them back.</p>
        <ul className="plain rows">
          {mind.funds.map((f) => (
            <li key={f.id}>
              <span>
                {f.name} <small className="muted">· {usd(f.saved)} of {usd(f.amount)} by {day(f.dueOn)}</small>
              </span>
              <b>{usd(f.monthly)}/mo</b>
              <button
                className="btn ghost small"
                aria-label={`Remove ${f.name}`}
                onClick={() => void confirm({ title: `Remove ${f.name}?`, confirmLabel: 'Remove', danger: true }).then((y) => void (y && run(api(`/api/money/funds/${f.id}`, 'DELETE'), 'Removed')))}
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
            void run(api('/api/money/funds', 'POST', fund), 'Fund added ✓').then((ok) => ok && setFund({ name: '', amount: '', dueOn: '', saved: '' }));
          }}
        >
          <input value={fund.name} onChange={(e) => setFund({ ...fund, name: e.target.value })} placeholder="For (car insurance, holidays…)" required />
          <input value={fund.amount} onChange={(e) => setFund({ ...fund, amount: e.target.value })} placeholder="Amount $" inputMode="decimal" required />
          <input type="date" value={fund.dueOn} onChange={(e) => setFund({ ...fund, dueOn: e.target.value })} aria-label="When it's due" required />
          <input value={fund.saved} onChange={(e) => setFund({ ...fund, saved: e.target.value })} placeholder="Saved so far $" inputMode="decimal" />
          <button className="btn small">Add</button>
        </form>
      </div>

      <div className="card" data-testid="mind-wants">
        <h2>The 24-hour list</h2>
        <p className="small muted">
          Want something over {usd(s.wantThreshold)} that isn’t essential? Put it here. Nothing is blocked — after a day, decide with a clear head.
        </p>
        <ul className="plain rows">
          {open.map((w) => (
            <li key={w.id}>
              <span>
                {w.what} <small className="muted">· {w.by} · {w.ready ? 'the day is up' : `ready ${new Date(w.readyAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`}</small>
              </span>
              <b>{usd(w.amount)}</b>
              <button className="btn ghost small" onClick={() => void run(api(`/api/money/wants/${w.id}/decide`, 'POST', { decided: 'bought' }), 'Noted ✓')}>
                Bought
              </button>
              <button className="btn ghost small" onClick={() => void run(api(`/api/money/wants/${w.id}/decide`, 'POST', { decided: 'let_go' }), 'Let go ✓')}>
                Let go
              </button>
            </li>
          ))}
        </ul>
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api('/api/money/wants', 'POST', want), 'Held for a day ✓').then((ok) => ok && setWant({ what: '', amount: '' }));
          }}
        >
          <input value={want.what} onChange={(e) => setWant({ ...want, what: e.target.value })} placeholder="What" required />
          <input value={want.amount} onChange={(e) => setWant({ ...want, amount: e.target.value })} placeholder="$" inputMode="decimal" required />
          <button className="btn small">Hold it</button>
        </form>
      </div>

      <div className="card" data-testid="mind-checks">
        <h2>Capture checks</h2>
        {mind.checks.length === 0 ? (
          <p className="muted">Nothing left on the table right now.</p>
        ) : (
          <ul className="plain">
            {mind.checks.map((c) => (
              <li key={c.key}>
                {c.text}
                {c.kind === 'review' && c.merchantKey && (
                  <span className="row">
                    <button className="btn ghost small" onClick={() => void run(api('/api/money/marks', 'PUT', { merchant: c.text.replace(/^Still using (.+?)\? .*$/, '$1'), merchantKey: c.merchantKey, mark: 'keep' }), 'Kept ✓')}>
                      Keep
                    </button>
                    <button className="btn ghost small" onClick={() => void run(api('/api/money/marks', 'PUT', { merchant: c.text.replace(/^Still using (.+?)\? .*$/, '$1'), merchantKey: c.merchantKey, mark: 'cancelled' }), 'Marked cancelled ✓')}>
                      I cancelled it
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api('/api/money/benefits', 'POST', benefit), 'Added ✓').then((ok) => ok && setBenefit({ kind: 'fsa', label: '', amount: '', deadline: '' }));
          }}
        >
          <select value={benefit.kind} onChange={(e) => setBenefit({ ...benefit, kind: e.target.value })} aria-label="Kind">
            <option value="fsa">FSA</option>
            <option value="dependent_care_fsa">Dependent-care FSA</option>
            <option value="hsa">HSA</option>
            <option value="other">Other</option>
          </select>
          <input value={benefit.label} onChange={(e) => setBenefit({ ...benefit, label: e.target.value })} placeholder="Name (2026 health FSA)" required />
          <input value={benefit.amount} onChange={(e) => setBenefit({ ...benefit, amount: e.target.value })} placeholder="Left $" inputMode="decimal" required />
          <input type="date" value={benefit.deadline} onChange={(e) => setBenefit({ ...benefit, deadline: e.target.value })} aria-label="Use by" required />
          <button className="btn small">Add</button>
        </form>
        <small className="muted">Use-it-or-lose-it money. Employer match is checked from Investments (add “most match $/mo”).</small>
      </div>
    </div>
  );
}
