import { useState } from 'react';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { when } from '../../dates';

interface InboxItem {
  id: number;
  kind: 'bill' | 'event' | 'task';
  summary: string;
  status: 'suggested' | 'added' | 'dismissed';
}
interface InboxEmail {
  id: number;
  from: string;
  subject: string;
  preview: string;
  at: string;
  items: InboxItem[];
}
interface InboxResponse {
  address: string | null;
  receiving: boolean;
  emails: InboxEmail[];
}

const KIND: Record<InboxItem['kind'], string> = { bill: 'Bill', event: 'Calendar', task: 'Task' };

/** Forward to Hana: a private address; Hana reads what arrives and suggests bills, events and tasks. */
export default function Inbox() {
  const { data, error, setData } = useLoad<InboxResponse>('/api/inbox');
  const [copied, setCopied] = useState(false);
  const confirm = useConfirm();
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const decide = (id: number, action: 'add' | 'dismiss'): void => void api<InboxResponse>(`/api/inbox/items/${id}/${action}`, 'POST').then(setData);
  return (
    <section data-testid="inbox">
      <h1>Hana’s inbox</h1>
      <p className="muted small">Forward bills, school emails and receipts here. Hana reads them and suggests what to add — nothing is added until you tap Add.</p>
      {!data.receiving && <p className="card note small">Email delivery isn’t switched on for this server yet — your address will start working once it is.</p>}
      <div className="card" data-testid="inbox-address">
        <h2>Your forwarding address</h2>
        {data.address ? (
          <>
            <input readOnly value={data.address} aria-label="Hana’s email address" onFocus={(e) => e.target.select()} data-testid="inbox-address-value" />
            <div className="row">
              <button className="btn small" onClick={() => void navigator.clipboard?.writeText(data.address ?? '').then(() => setCopied(true))}>
                {copied ? 'Copied ✓' : 'Copy address'}
              </button>
              <span className="grow" />
              <button
                className="link danger small"
                onClick={() =>
                  void confirm({ title: 'Make a new address?', body: 'The old one stops working — update your forwarding to the new one.', confirmLabel: 'New address', danger: true }).then(
                    (y) => void (y && api<InboxResponse>('/api/inbox/address', 'POST').then(setData)),
                  )
                }
              >
                New address
              </button>
            </div>
            <details className="small">
              <summary>How to forward from Gmail</summary>
              <ol>
                <li>Gmail on a computer → Settings (gear) → See all settings → Forwarding and POP/IMAP → Add a forwarding address → paste this address.</li>
                <li>Gmail sends a confirmation code to this address — it shows up below in a minute. Type it back into Gmail.</li>
                <li>Then make a filter (search bar → Show search options) for the mail you want Hana to read, e.g. from your power company or your kids’ school → Create filter → Forward it to this address.</li>
              </ol>
              <p>Or just forward any single email to this address by hand.</p>
            </details>
          </>
        ) : (
          <button className="btn small" onClick={() => void api<InboxResponse>('/api/inbox/address', 'POST').then(setData)} data-testid="make-address">
            Make my Hana address
          </button>
        )}
      </div>
      {data.emails.length === 0 && <p className="muted">Nothing forwarded yet.</p>}
      {data.emails.map((m) => (
        <div key={m.id} className="card" data-testid="inbox-email">
          <div className="row">
            <b className="grow">{m.subject}</b>
            <small className="muted">{when(m.at)}</small>
          </div>
          <small className="muted">From {m.from || 'unknown'}</small>
          <p className="small" style={{ whiteSpace: 'pre-wrap' }}>
            {m.preview}
            {m.preview.length >= 240 ? '…' : ''}
          </p>
          {m.items.map((i) => (
            <div key={i.id} className="row inbox-item" data-testid="inbox-item">
              <span className="pill">{KIND[i.kind]}</span>
              <span className="grow small">{i.summary}</span>
              {i.status === 'suggested' ? (
                <>
                  <button className="btn small" onClick={() => decide(i.id, 'add')}>
                    Add
                  </button>
                  <button className="link small" onClick={() => decide(i.id, 'dismiss')}>
                    Dismiss
                  </button>
                </>
              ) : (
                <small className="muted">{i.status === 'added' ? 'Added ✓' : 'Dismissed'}</small>
              )}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
