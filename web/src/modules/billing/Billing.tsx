import { useState } from 'react';
import type { BillingResponse } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';

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
  const go = async (path: string): Promise<void> => {
    try {
      const r = await api<{ url: string }>(path, 'POST');
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
        <b>{STATUS[data.status]}</b>
        <span className="muted">
          {data.status === 'trialing' && data.trialDaysLeft !== null
            ? `${data.trialDaysLeft} day${data.trialDaysLeft === 1 ? '' : 's'} left · ends ${data.trialEndsAt?.slice(0, 10)}`
            : data.status === 'trial_ended'
              ? 'Everything still works while pricing is being finalized.'
              : ''}
        </span>
      </div>

      <div className="card" data-testid="billing-plan">
        <h2>Plan</h2>
        {plan ? (
          <p>
            <b>{plan.name}</b> — one price for the whole household ·{' '}
            {plan.priceCents === null ? <span className="muted">price not set yet</span> : `${money(plan.priceCents, plan.currency)} / ${plan.interval}`}
          </p>
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
              <button className="btn" disabled={plan?.priceCents == null} onClick={() => void go('/api/billing/checkout')}>
                Subscribe{plan?.priceCents != null ? ` · ${money(plan.priceCents, plan.currency)} / ${plan.interval}` : ''}
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
            <button className="btn small" disabled={!data.paymentMethod || plan?.priceCents == null} onClick={() => void run(api('/api/billing/subscribe', 'POST'), 'Plan started (test mode — no charge)')}>
              Start the paid plan
            </button>
          )}
        </div>
      )}
    </section>
  );
}
