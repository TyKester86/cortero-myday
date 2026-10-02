import { useState } from 'react';
import { HOUSEHOLD_TYPE_INFO, type AdminDashboard, type BillingPlan } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { money } from './Billing';

function PlanRow({ p, onSave }: { p: BillingPlan; onSave: (patch: Record<string, unknown>) => void }) {
  const [price, setPrice] = useState(p.priceCents === null ? '' : (p.priceCents / 100).toFixed(2));
  const [interval, setInterval] = useState(p.interval);
  return (
    <li>
      <span className="grow">
        <b>{p.name}</b> <small className="muted">{p.code}</small> {p.isDefault && <span className="pill sun">default</span>} {!p.active && <span className="pill">inactive</span>}
      </span>
      <input aria-label={`${p.name} price`} style={{ width: 90 }} inputMode="decimal" placeholder="not set" value={price} onChange={(e) => setPrice(e.target.value)} />
      <select aria-label={`${p.name} interval`} value={interval} onChange={(e) => setInterval(e.target.value as 'month' | 'year')}>
        <option value="month">/ month</option>
        <option value="year">/ year</option>
      </select>
      <button className="btn small" onClick={() => onSave({ priceCents: price.trim() === '' ? null : Math.round(Number(price) * 100), interval })}>
        Save
      </button>
      {!p.isDefault && (
        <button className="link" onClick={() => onSave({ isDefault: true })}>
          Make default
        </button>
      )}
    </li>
  );
}

/** MyDay staff: households, plans, trials, MRR — and deleting test households. */
export default function Admin() {
  const confirm = useConfirm();
  const { data, error, setData } = useLoad<AdminDashboard>('/api/admin/dashboard');
  const [q, setQ] = useState('');
  const [plan, setPlan] = useState({ code: '', name: '' });
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const run = async (p: Promise<AdminDashboard>, ok: string): Promise<void> => {
    try {
      setData(await p);
      setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const t = data.totals;
  const shown = data.households.filter((h) => !q || h.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="page-admin">
      <h1>Admin</h1>
      <p className="muted small">
        Payments: <b>{data.provider === 'none' ? 'not live' : 'stub (test mode, never charges)'}</b> — MRR is what active households would pay at the current plan prices.
      </p>
      {msg && <p className="muted" role="status">{msg}</p>}
      <p>
        <a href="/circles/moderation">Circles moderation queue →</a>
      </p>
      <div className="stats" data-testid="admin-totals">
        <div className="stat">
          <b>{t.households}</b>
          <small>households</small>
        </div>
        <div className="stat">
          <b>{t.trialing}</b>
          <small>in trial ({t.trialsEndingThisWeek} end this week)</small>
        </div>
        <div className="stat">
          <b>{t.active}</b>
          <small>paying</small>
        </div>
        <div className="stat">
          <b data-testid="admin-mrr">{money(t.mrrCents)}</b>
          <small>MRR{t.unpriced ? ` (${t.unpriced} unpriced)` : ''}</small>
        </div>
      </div>
      <p className="small muted">
        Trial ended {t.trialEnded} · past due {t.pastDue} · canceled {t.canceled} · complimentary {t.comped}
      </p>

      <div className="card" data-testid="admin-plans">
        <h2>Plans (flat price per household)</h2>
        <ul className="plain rows">
          {data.plans.map((p) => (
            <PlanRow key={p.id} p={p} onSave={(patch) => void run(api(`/api/admin/plans/${p.id}`, 'PATCH', patch), `${p.name} saved`)} />
          ))}
        </ul>
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api('/api/admin/plans', 'POST', plan), 'Plan added').then(() => setPlan({ code: '', name: '' }));
          }}
        >
          <input value={plan.code} onChange={(e) => setPlan({ ...plan, code: e.target.value })} placeholder="code (e.g. household-yearly)" required />
          <input value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} placeholder="Name" required />
          <button className="btn small">Add plan</button>
        </form>
      </div>

      <div className="card" data-testid="admin-households">
        <h2>Households</h2>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search households" aria-label="Search households" />
        <ul className="plain rows">
          {shown.map((h) => (
            <li key={h.id}>
              <span className="grow">
                <b>{h.name}</b>{' '}
                <small className="muted">
                  {HOUSEHOLD_TYPE_INFO[h.type]?.label ?? h.type} · {h.members} people · since {h.createdAt.slice(0, 10)} · {h.plan ?? 'no plan'} ·{' '}
                  <b>{h.status.replace('_', ' ')}</b>
                  {h.status === 'trialing' && h.trialEndsAt && ` until ${h.trialEndsAt.slice(0, 10)}`}
                </small>
              </span>
              <select
                aria-label={`${h.name} status`}
                value=""
                onChange={(e) => e.target.value && void run(api(`/api/admin/households/${h.id}`, 'PATCH', { status: e.target.value }), `${h.name} updated`)}
              >
                <option value="">Set status…</option>
                {['trialing', 'active', 'past_due', 'canceled', 'comped'].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                className="link danger"
                aria-label={`Delete ${h.name}`}
                onClick={() =>
                  void confirm({
                    title: `Delete “${h.name}”?`,
                    body: `This permanently deletes the household and everything in it (${h.members} people). It can’t be undone — only restored from a backup.`,
                    confirmLabel: 'Delete household',
                    danger: true,
                  }).then((y) => void (y && run(api(`/api/admin/households/${h.id}?confirm=${encodeURIComponent(h.name)}`, 'DELETE'), `${h.name} deleted`)))
                }
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
