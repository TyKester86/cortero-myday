/**
 * Creator earnings: tips and monthly support, paid through Stripe straight to the creator. Optional for everyone —
 * the Feed itself is free.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { CreatorInfo, CreatorPublic } from '@myday/shared';
import { api, useLoad } from '../../api';
import { ago } from '../../dates';
import { count } from '../../format';
import { Gate } from '../community/Community';
import { FeedNav, FeedTitle } from './shell';

const money = (c: number): string => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const TIPS = [200, 500, 1000];

/** On someone else's profile: tip them, or support them monthly. */
export function SupportBox({ userId, name }: { userId: number; name: string }) {
  const { data, reload } = useLoad<CreatorPublic>(`/api/creator/${userId}/public`);
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(params.get('tip') === 'thanks' ? `Thank you — your tip is on its way to ${name}.` : params.get('support') === 'thanks' ? `Thank you for supporting ${name}.` : null);
  if (!data || (!data.tips && !data.subCents && !data.supporting)) return msg ? <p className="good" role="status">{msg}</p> : null;
  const go = async (path: string, body?: unknown): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ url: string }>(path, 'POST', body);
      // Stripe's checkout (or, without Stripe, straight back here).
      if (new URL(r.url, window.location.href).origin === window.location.origin) {
        window.history.replaceState(null, '', r.url);
        setMsg(r.url.includes('tip=') ? `Thank you — your tip is on its way to ${name}.` : `Thank you for supporting ${name}.`);
        reload();
      } else window.location.href = r.url;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'That didn’t go through');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="support-box" data-testid="support-box" aria-label={`Support ${name}`}>
      {data.tips && (
        <div className="row">
          <span className="small grow">Send {name} a tip</span>
          {TIPS.map((c) => (
            <button key={c} type="button" className="btn ghost small" disabled={busy} onClick={() => void go(`/api/creator/${userId}/tip`, { cents: c })} data-testid={`tip-${c}`}>
              {money(c)}
            </button>
          ))}
        </div>
      )}
      {data.supporting ? (
        <p className="row small">
          <span className="grow" data-testid="supporting">
            You support {name} monthly ✓
          </span>
          <button type="button" className="link small" onClick={() => void api(`/api/creator/${userId}/unsubscribe`, 'POST').then(reload)} data-testid="support-stop">
            Stop
          </button>
        </p>
      ) : (
        data.subCents && (
          <button type="button" className="btn small" disabled={busy} onClick={() => void go(`/api/creator/${userId}/subscribe`)} data-testid="support-monthly">
            Support {name} · {money(data.subCents)}/month
          </button>
        )
      )}
      <small className="muted">Optional — the Feed is free for everyone. Payments go to {name} through Stripe.</small>
      {msg && (
        <p className="good small" role="status" data-testid="support-msg">
          {msg}
        </p>
      )}
    </section>
  );
}

/** Your earnings: connect Stripe, turn tips on, offer monthly support, see who supports you. */
export function EarningsPage() {
  return (
    <section className="feed-page" data-testid="earnings-page">
      <FeedTitle>Earnings</FeedTitle>
      <FeedNav />
      <Gate>{() => <Earnings />}</Gate>
    </section>
  );
}

function Earnings() {
  const { data, setData } = useLoad<CreatorInfo>('/api/creator');
  const sup = useLoad<{ items: Array<{ kind: 'tip' | 'monthly'; name: string; cents: number; at: string }> }>('/api/creator/supporters');
  const [price, setPrice] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <p className="muted">Loading…</p>;
  const connect = async (): Promise<void> => {
    setMsg(null);
    try {
      const r = await api<{ url: string | null; info: CreatorInfo }>('/api/creator/connect', 'POST');
      if (r.url) window.location.href = r.url;
      else setData(r.info);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not start');
    }
  };
  const save = async (patch: { tipsEnabled?: boolean; subCents?: number | null }): Promise<void> => {
    setMsg(null);
    try {
      setData(await api<CreatorInfo>('/api/creator', 'PUT', patch));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const e = data.earnings;
  return (
    <>
      <section className="card" data-testid="earnings-summary">
        <div className="stats-grid">
          <div className="stat-tile">
            <b>{money(e.tipsCents)}</b>
            <small className="muted">from {count(e.tips, 'tip')}</small>
          </div>
          <div className="stat-tile">
            <b>{money(e.last30Cents)}</b>
            <small className="muted">tips, last 30 days</small>
          </div>
          <div className="stat-tile">
            <b>{e.supporters}</b>
            <small className="muted">monthly supporters ({money(e.monthlyCents)}/mo)</small>
          </div>
        </div>
        <p className="small muted">Paid out by Stripe to your bank on Stripe’s schedule.{data.feePct ? ` The Feed keeps ${data.feePct}%.` : ''}</p>
      </section>
      {data.status !== 'active' ? (
        <section className="card" data-testid="creator-connect-card">
          <b>{data.status === 'none' ? 'Get paid by the people who love what you post' : data.status === 'pending' ? 'Finish setting up with Stripe' : 'Stripe needs a little more from you'}</b>
          <p className="small muted">Tips and monthly support go straight to your own Stripe account. Stripe checks who you are and where to send the money.</p>
          <button type="button" className="btn" onClick={() => void connect()} disabled={data.payments === 'none'} data-testid="creator-connect">
            {data.status === 'none' ? 'Set up payouts with Stripe' : 'Continue with Stripe'}
          </button>
        </section>
      ) : (
        <section className="card form" data-testid="creator-settings">
          <label className="inline-label">
            <input type="checkbox" checked={data.tipsEnabled} onChange={(ev) => void save({ tipsEnabled: ev.target.checked })} data-testid="creator-tips" /> Take tips on my profile
          </label>
          <label>
            Monthly support {data.subCents ? `(now ${money(data.subCents)}/month)` : '(off)'}
            <span className="row">
              <input inputMode="decimal" value={price} onChange={(ev) => setPrice(ev.target.value)} placeholder="e.g. 4" aria-label="Monthly price in dollars" data-testid="creator-sub" />
              <button type="button" className="btn small" onClick={() => void save({ subCents: Math.round(Number(price) * 100) })} disabled={!Number(price)} data-testid="creator-sub-save">
                Set price
              </button>
              {data.subCents && (
                <button type="button" className="link small" onClick={() => void save({ subCents: null })}>
                  Turn off
                </button>
              )}
            </span>
          </label>
        </section>
      )}
      {msg && <p className="error">{msg}</p>}
      <section className="card" data-testid="supporters">
        <b>Supporters</b>
        <ul className="plain">
          {sup.data?.items.map((i, n) => (
            <li key={n} className="small">
              {i.name} — {i.kind === 'tip' ? `${money(i.cents)} tip` : `${money(i.cents)}/month`} · {ago(i.at)}
            </li>
          ))}
          {sup.data && !sup.data.items.length && <li className="muted small">No tips or supporters yet.</li>}
        </ul>
      </section>
    </>
  );
}
