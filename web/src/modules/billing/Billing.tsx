import { useState } from 'react';
import type { BillingOption, BillingResponse } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { count } from '../../format';

export function money(cents: number | null, currency = 'usd'): string {
  if (cents === null) return 'not set yet';
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: currency.toUpperCase() });
}

const STATUS: Record<BillingResponse['status'], string> = {
  trialing: 'Free trial',
  trial_ended: 'Trial ended',
  active: 'Active',
  past_due: 'Payment past due',
  canceled: 'Canceled',
  comped: 'Complimentary',
};

/** The household's plan, trial and payment method. Nothing is ever charged while payments aren't live. */
export default function Billing() {
  const confirm = useConfirm();
  const { data, error, setData } = useLoad<BillingResponse>('/api/billing');
  const [msg, setMsg] = useState<string | null>(null);
  const [tier, setTier] = useState<BillingOption['tier'] | null>(null);
  const [interval, setInterval_] = useState<BillingOption['interval'] | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const run = async (p: Promise<BillingResponse>, ok: string): Promise<void> => {
    try {
      setData(await p);
      setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const plan = data.plan;
  // The pick: what they chose, else their current plan's tier/interval, else Family monthly.
  const t = tier ?? (data.options.some((o) => o.tier === plan?.tier) ? (plan?.tier ?? 'family') : 'family');
  const iv = interval ?? plan?.interval ?? 'month';
  const picked = data.options.find((o) => o.tier === t && o.interval === iv) ?? data.options[0] ?? null;
  const go = async (path: string, body?: unknown): Promise<void> => {
    try {
      const r = await api<{ url: string }>(path, 'POST', body);
      window.location.href = r.url;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not open billing');
    }
  };
  const paid = new URLSearchParams(window.location.search).has('paid');
  return (
    <section>
      <h1>Billing</h1>
      {paid && <p className="good" role="status">Thank you! Your subscription is set up — it can take a moment to show here.</p>}
      {msg && <p className="muted" role="status">{msg}</p>}
      <div className="bigscore" data-testid="billing-status">
        <b className="word">{STATUS[data.status]}</b>
        <span className="muted">
          {data.status === 'trialing' && data.trialDaysLeft !== null
            ? `${data.trialDaysLeft} day${data.trialDaysLeft === 1 ? '' : 's'} left · ends ${data.trialEndsAt?.slice(0, 10)}`
            : data.status === 'trial_ended'
              ? 'Everything still works while pricing is being finalized.'
              : ''}
        </span>
      </div>

      {data.catalog.length > 0 && (
        <PlanPicker
          catalog={data.catalog}
          options={data.options}
          adults={data.adults}
          // Already paying (or complimentary): the prices are shown, but picking happens in “Manage billing”.
          readOnly={data.status === 'comped' || data.status === 'active' || data.status === 'past_due'}
          current={plan?.tier ?? null}
          tier={t}
          interval={iv}
          foundingLeft={data.foundingLeft}
          onTier={setTier}
          onInterval={setInterval_}
        />
      )}

      <div className="card" data-testid="billing-plan">
        <h2>{data.status === 'active' || data.status === 'past_due' ? 'Your plan' : 'Current plan'}</h2>
        {plan ? (
          <>
            <p>
              <b>{plan.name}</b> — {plan.tier === 'solo' ? 'for one grown-up' : 'one price for the whole household'} ·{' '}
              {plan.priceCents === null ? <span className="muted">price not set yet</span> : `${money(plan.priceCents, plan.currency)} / ${plan.interval}`}
              {data.status === 'comped' && <span className="muted"> (complimentary — nothing to pay)</span>}
            </p>
            <p className="small muted" data-testid="hana-allowance">
              Hana: {data.hanaDailyCap === null ? 'unlimited' : `${data.hanaDailyCap} messages a day for the household`}.
            </p>
          </>
        ) : (
          <p className="muted">No plan yet.</p>
        )}
      </div>

      {data.provider === 'stripe' && data.status !== 'comped' && (
        <div className="card" data-testid="billing-stripe">
          <h2>Subscription</h2>
          {data.status === 'active' || data.status === 'past_due' ? (
            <>
              {data.status === 'past_due' && <p className="warn small">Your last payment didn’t go through. Update your card to keep things running smoothly.</p>}
              <button className="btn small" onClick={() => void go('/api/billing/portal')}>
                Manage billing
              </button>
              <p className="small muted">Change your card, see invoices, or cancel — on Stripe’s secure page.</p>
            </>
          ) : (
            <>
              <p className="small">
                {data.status === 'trialing' ? 'Subscribe now and you won’t be charged until your free trial ends.' : 'Pick up where you left off — one price for the whole household.'}
              </p>
              <button className="btn" disabled={!picked} onClick={() => void go('/api/billing/checkout', { planId: picked?.planId })} data-testid="billing-subscribe">
                Subscribe{picked ? ` · ${picked.name} ${money(picked.priceCents, picked.currency)} / ${picked.interval}` : ''}
              </button>
              {data.status === 'canceled' && data.paidThrough && <p className="small muted">Paid through {data.paidThrough.slice(0, 10)}.</p>}
              <p className="small muted">Secure checkout by Stripe — MyDay never sees your card number.</p>
            </>
          )}
        </div>
      )}

      {data.provider !== 'stripe' && (
      <div className="card" data-testid="billing-payment">
        <h2>Payment method</h2>
        {data.provider === 'none' && <p className="muted small">Payments aren’t live yet. You won’t be asked for a card or charged during your trial.</p>}
        {data.provider === 'stub' && <p className="warn small">Test mode: only a test card can be added, and nothing is ever charged.</p>}
        {data.paymentMethod ? (
          <div className="row">
            <span className="grow">
              {data.paymentMethod.brand} •••• {data.paymentMethod.last4} {data.paymentMethod.test && <span className="pill">test</span>}
            </span>
            <button
              className="btn small ghost"
              onClick={() =>
                void confirm({ title: 'Remove this payment method?', confirmLabel: 'Remove', danger: true }).then(
                  (y) => void (y && run(api('/api/billing/payment-method', 'DELETE'), 'Removed')),
                )
              }
            >
              Remove
            </button>
          </div>
        ) : (
          <button className="btn small" disabled={data.provider !== 'stub'} onClick={() => void run(api('/api/billing/payment-method', 'POST', { last4: '4242' }), 'Test card added')}>
            Add payment method
          </button>
        )}
      </div>

      )}

      {data.provider === 'stub' && data.status !== 'comped' && (
        <div className="card">
          {data.status === 'active' ? (
            <button
              className="btn small ghost"
              onClick={() =>
                void confirm({ title: 'Cancel the paid plan?', body: 'You can start it again any time.', confirmLabel: 'Cancel plan', danger: true }).then(
                  (y) => void (y && run(api('/api/billing/cancel', 'POST'), 'Plan canceled')),
                )
              }
            >
              Cancel plan
            </button>
          ) : (
            <button className="btn small" disabled={!data.paymentMethod || !picked} onClick={() => void run(api('/api/billing/subscribe', 'POST', { planId: picked?.planId }), 'Plan started (test mode — no charge)')}>
              Start the paid plan
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const TIERS: Record<BillingOption['tier'], { label: string; blurb: string }> = {
  solo: { label: 'Solo', blurb: 'Everything in MyDay for one grown-up. Hana: 50 messages a day.' },
  family: { label: 'Family', blurb: 'Everything in MyDay for the whole household. Hana: 50 messages a day, shared.' },
  familyplus: { label: 'Family+', blurb: 'Everything in Family, plus unlimited Hana.' },
};

/** Solo, Family or Family+, monthly or yearly. Family shows the founding price while spots last. */
function PlanPicker(p: {
  catalog: BillingOption[];
  options: BillingOption[];
  adults: number;
  readOnly: boolean;
  current: BillingOption['tier'] | null;
  tier: BillingOption['tier'];
  interval: BillingOption['interval'];
  foundingLeft: number | null;
  onTier: (t: BillingOption['tier']) => void;
  onInterval: (i: BillingOption['interval']) => void;
}) {
  const of = (tier: BillingOption['tier'], interval: BillingOption['interval']): BillingOption | undefined => p.catalog.find((o) => o.tier === tier && o.interval === interval);
  const canPick = (tier: BillingOption['tier']): boolean => p.options.some((o) => o.tier === tier);
  const tiers = (['solo', 'family', 'familyplus'] as const).filter((t) => p.catalog.some((o) => o.tier === t));
  const save = (tier: BillingOption['tier']): string | null => {
    const m = of(tier, 'month');
    const y = of(tier, 'year');
    return m && y ? `save ${Math.round((1 - y.priceCents / (m.priceCents * 12)) * 100)}%` : null;
  };
  return (
    <div className="card" data-testid="plan-picker">
      <h2>{p.readOnly ? 'Plans' : 'Choose a plan'}</h2>
      <p className="small muted">{p.readOnly ? 'What each plan costs. To switch, use “Manage billing”.' : 'Change or cancel any time.'}</p>
      <div className="chips" role="group" aria-label="Billing period">
        {(['month', 'year'] as const).map((i) => (
          <button key={i} type="button" className={p.interval === i ? 'chip on' : 'chip'} aria-pressed={p.interval === i} onClick={() => p.onInterval(i)}>
            {i === 'month' ? 'Monthly' : 'Yearly'}
          </button>
        ))}
      </div>
      <div className="plan-grid">
        {tiers.map((tier) => {
          const o = of(tier, p.interval);
          if (!o) return null;
          const pickable = !p.readOnly && canPick(tier);
          const on = p.readOnly ? p.current === tier : p.tier === tier && pickable;
          return (
            <button key={tier} type="button" className={on ? 'plan-opt on' : !p.readOnly && !canPick(tier) ? 'plan-opt off' : 'plan-opt'} aria-pressed={on} disabled={!pickable} onClick={() => p.onTier(tier)} data-testid={`plan-${tier}`}>
              <b>{TIERS[tier].label}</b>
              <span className="plan-price">
                {money(o.priceCents, o.currency)} <small>/ {o.interval}</small>
              </span>
              {o.founding && <span className="pill sun">Founding price — yours for life</span>}
              {p.interval === 'year' && save(tier) && <small className="muted">{save(tier)} vs monthly</small>}
              <small className="muted">{TIERS[tier].blurb}</small>
              {p.readOnly && p.current === tier && <span className="pill">Your plan</span>}
              {!p.readOnly && !canPick(tier) && tier === 'solo' && <small className="muted">For one grown-up — your household has {p.adults}.</small>}
            </button>
          );
        })}
      </div>
      {p.foundingLeft !== null && p.options.some((o) => o.founding) && (
        <p className="small muted">
          {`${count(p.foundingLeft, 'founding spot')} left at the founding price.`}
        </p>
      )}
    </div>
  );
}
