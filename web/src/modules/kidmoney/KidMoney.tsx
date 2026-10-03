import { useState } from 'react';
import { WEEKDAYS, type KidMoneyResponse, type LedgerKind, type LinkTokenResponse, type Weekday } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { useSession } from '../../session';
import { loadPlaid } from '../money/Money';
import { day } from '../../dates';

const usd = (n: number): string => n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const CATS = ['Food & snacks', 'Games & apps', 'Clothes', 'Fun & outings', 'Gifts', 'School', 'Other'];
const KIND_LABEL: Record<LedgerKind, string> = {
  allowance: 'Allowance',
  cash: 'Cash',
  gift: 'Gift',
  earned: 'Earned',
  spend: 'Spent',
  to_goal: 'Into savings',
  from_goal: 'Out of savings',
};

/**
 * A kid's (or teen's) own money. Kids see one big spendable number, record
 * spending and save toward goals; grown-ups add money and set the allowance.
 * Teens can see a real account read-only — a parent links and unlinks it.
 * MyDay never moves anyone's money.
 */
export default function KidMoney() {
  const { viewing, members, isAdult } = useSession();
  const confirm = useConfirm();
  const kids = members.filter((m) => m.kind === 'kid');
  const [pick, setPick] = useState<string>(viewing?.kind === 'kid' ? viewing.key : (kids[0]?.key ?? ''));
  const key = isAdult ? pick : (viewing?.key ?? '');
  const { data, error, setData } = useLoad<KidMoneyResponse>(key ? withMember('/api/kidmoney', key) : null);
  const [entry, setEntry] = useState({ amount: '', kind: 'spend' as LedgerKind, category: 'Food & snacks', note: '' });
  const [goal, setGoal] = useState({ name: '', target: '' });
  const [move, setMove] = useState<Record<number, string>>({});
  const [allow, setAllow] = useState<{ amount: string; weekday: Weekday }>({ amount: '', weekday: 'Sat' });
  const [msg, setMsg] = useState<string | null>(null);

  if (isAdult && kids.length === 0) return <p className="muted">Add a kid on the Household page to set up their money.</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const run = async (p: Promise<KidMoneyResponse>, ok: string): Promise<void> => {
    try {
      setData(await p);
      setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const member = data.member.key;

  const linkBank = async (): Promise<void> => {
    try {
      const { provider, linkToken } = await api<LinkTokenResponse>(`/api/kidmoney/${member}/bank/link-token`, 'POST');
      if (provider === 'fake') {
        await run(api(`/api/kidmoney/${member}/bank/exchange`, 'POST', { publicToken: `public-fake-${linkToken.slice(-6)}`, institution: 'Demo Bank (fake)' }), 'Linked (read-only) ✓');
        return;
      }
      const Plaid = await loadPlaid();
      Plaid.create({
        token: linkToken,
        onSuccess: (publicToken, meta) =>
          void run(api(`/api/kidmoney/${member}/bank/exchange`, 'POST', { publicToken, institution: meta.institution?.name ?? 'Bank' }), 'Linked (read-only) ✓'),
      }).open();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not start the link');
    }
  };

  return (
    <section>
      <h1>{isAdult ? `${data.member.name}'s money` : 'My money'}</h1>
      {isAdult && kids.length > 1 && (
        <div className="chips">
          {kids.map((k) => (
            <button key={k.key} className={k.key === key ? 'chip on' : 'chip'} onClick={() => setPick(k.key)}>
              {k.name}
            </button>
          ))}
        </div>
      )}
      <div className="bigscore">
        <b data-testid="spendable">{usd(data.spendable)}</b>
        <span className="muted">yours to spend</span>
      </div>
      {data.allowance && (
        <p className="muted small" style={{ textAlign: 'center' }}>
          Allowance {usd(data.allowance.amount)} every {data.allowance.weekday}
        </p>
      )}
      {msg && <p className="muted" role="status">{msg}</p>}

      <div className="card" data-testid="ledger-entry">
        <h2>{data.canManage ? 'Add money or spending' : 'I spent money'}</h2>
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api('/api/kidmoney/entries', 'POST', { ...entry, kind: data.canManage ? entry.kind : 'spend', member }), 'Saved ✓').then(() => setEntry({ ...entry, amount: '', note: '' }));
          }}
        >
          {data.canManage && (
            <select value={entry.kind} onChange={(e) => setEntry({ ...entry, kind: e.target.value as LedgerKind })} aria-label="Kind">
              {(['allowance', 'cash', 'gift', 'earned', 'spend'] as LedgerKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          )}
          <input value={entry.amount} onChange={(e) => setEntry({ ...entry, amount: e.target.value })} placeholder="$" inputMode="decimal" required />
          {(entry.kind === 'spend' || !data.canManage) && (
            <select value={entry.category} onChange={(e) => setEntry({ ...entry, category: e.target.value })} aria-label="Category">
              {CATS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
          <input value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} placeholder="What for?" maxLength={80} />
          <button className="btn small">Save</button>
        </form>
      </div>

      <div className="card" data-testid="goals">
        <h2>Saving for</h2>
        {data.goals.length === 0 && <p className="muted small">Pick something you want and watch it fill up.</p>}
        {data.goals.map((g) => (
          <div key={g.id} className="quest">
            <span className="grow">
              <b>{g.done ? '🎉 ' : ''}{g.name}</b> <small className="muted">{usd(g.saved)} of {usd(g.target)}</small>
              <div className="bar">
                <i style={{ width: `${g.pct}%` }} />
              </div>
            </span>
            <input aria-label={`Amount for ${g.name}`} style={{ width: 70 }} inputMode="decimal" placeholder="$" value={move[g.id] ?? ''} onChange={(e) => setMove({ ...move, [g.id]: e.target.value })} />
            <button className="btn small" onClick={() => void run(api(`/api/kidmoney/goals/${g.id}/move`, 'POST', { amount: move[g.id], direction: 'in', member }), 'Saved toward it ✓')}>
              In
            </button>
            <button className="btn small ghost" onClick={() => void run(api(`/api/kidmoney/goals/${g.id}/move`, 'POST', { amount: move[g.id], direction: 'out', member }), 'Moved back ✓')}>
              Out
            </button>
            <button
              className="link danger"
              aria-label={`Remove ${g.name}`}
              onClick={() =>
                void confirm({ title: `Remove “${g.name}”?`, body: 'What you saved goes back to spendable.', confirmLabel: 'Remove', danger: true }).then(
                  (y) => void (y && run(api(withMember(`/api/kidmoney/goals/${g.id}`, member), 'DELETE'), 'Goal removed')),
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
            void run(api('/api/kidmoney/goals', 'POST', { ...goal, member }), 'Goal added ✓').then(() => setGoal({ name: '', target: '' }));
          }}
        >
          <input value={goal.name} onChange={(e) => setGoal({ ...goal, name: e.target.value })} placeholder="Goal (e.g. new game)" required maxLength={40} />
          <input value={goal.target} onChange={(e) => setGoal({ ...goal, target: e.target.value })} placeholder="$ target" inputMode="decimal" required />
          <button className="btn small">Add goal</button>
        </form>
      </div>

      {data.categories.length > 0 && (
        <div className="card">
          <h2>Where it went (30 days)</h2>
          <ul className="plain small">
            {data.categories.map((c) => (
              <li key={c.category}>
                {c.category}: {usd(c.spent)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>History</h2>
        <ul className="plain rows small" data-testid="ledger">
          {data.ledger.map((e) => (
            <li key={e.id}>
              <span>
                {day(e.date)} · {KIND_LABEL[e.kind]}
                {e.category && ` · ${e.category}`}
                {e.note && ` · ${e.note}`}
              </span>
              <span className="row">
                <b className={['spend', 'to_goal'].includes(e.kind) ? '' : 'good'}>
                  {['spend', 'to_goal'].includes(e.kind) ? '−' : '+'}
                  {usd(e.amount)}
                </b>
                {data.canManage && !['to_goal', 'from_goal'].includes(e.kind) && (
                  <button
                    className="link danger"
                    aria-label="Delete entry"
                    onClick={() =>
                      void confirm({ title: 'Delete this entry?', confirmLabel: 'Delete', danger: true }).then((y) => void (y && run(api(withMember(`/api/kidmoney/entries/${e.id}`, member), 'DELETE'), 'Deleted')))
                    }
                  >
                    ✕
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {data.canManage && (
        <div className="card" data-testid="allowance">
          <h2>Allowance</h2>
          <p className="muted small">Paid automatically into {data.member.name}'s spendable money each week (record-keeping only).</p>
          <div className="form wide">
            <input value={allow.amount} onChange={(e) => setAllow({ ...allow, amount: e.target.value })} placeholder={data.allowance ? String(data.allowance.amount) : '$ per week'} inputMode="decimal" />
            <select value={allow.weekday} onChange={(e) => setAllow({ ...allow, weekday: e.target.value as Weekday })} aria-label="Payday">
              {WEEKDAYS.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
            <button className="btn small" onClick={() => void run(api('/api/kidmoney/allowance', 'PUT', { ...allow, member }), 'Allowance set ✓')}>
              Set
            </button>
            {data.allowance && (
              <button className="btn small ghost" onClick={() => void run(api('/api/kidmoney/allowance', 'PUT', { amount: 0, member }), 'Allowance stopped')}>
                Stop
              </button>
            )}
          </div>
        </div>
      )}

      {data.isTeen && (
        <div className="card" data-testid="teen-bank">
          <h2>Bank account (read-only)</h2>
          {data.bank ? (
            <>
              <p className="small">
                {data.bank.institution} · {data.bank.accounts.map((a) => `${a.name} ${usd(a.available ?? a.current ?? 0)}`).join(' · ')}
              </p>
              <ul className="plain small">
                {data.bank.recent.map((t) => (
                  <li key={t.id}>
                    {day(t.date)} · {t.merchant || t.name} · {usd(-t.amount)}
                  </li>
                ))}
              </ul>
              {data.canManage && (
                <button
                  className="btn small ghost"
                  onClick={() =>
                    void confirm({ title: 'Unlink this bank?', body: 'Its data is deleted from MyDay.', confirmLabel: 'Unlink', danger: true }).then(
                      (y) => void (y && run(api(`/api/kidmoney/${member}/bank`, 'DELETE'), 'Unlinked')),
                    )
                  }
                >
                  Unlink (parent)
                </button>
              )}
            </>
          ) : data.canManage ? (
            data.bankLinkAllowed ? (
              <button className="btn small" onClick={() => void linkBank()}>
                Link {data.member.name}'s account (read-only)
              </button>
            ) : (
              <p className="muted small">Turn on “Teens can see a bank account” in Household settings to link one.</p>
            )
          ) : (
            <p className="muted small">A parent can link your bank account so you can see it here. MyDay can only look — it can't move money.</p>
          )}
        </div>
      )}
    </section>
  );
}
