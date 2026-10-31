/**
 * H6 in the app: drafted notes (edit, send or discard), notes delivered to you, and the
 * parents' audit log of everything Hana prepared — who approved or discarded it, and when.
 */
import { useState } from 'react';
import type { HanaAction, HanaLogEntry, HanaNote, HanaSuggestionEntry } from '@myday/shared';
import { api, useLoad } from '../../api';

/** A drafted note, editable until it's sent. */
export function DraftCard({ a, onDecide, onSaved }: { a: HanaAction; onDecide: (verb: 'confirm' | 'cancel') => void; onSaved: (a: HanaAction) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(a.draft?.text ?? '');
  const [err, setErr] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    try {
      const r = await api<{ action: HanaAction }>(`/api/hana/actions/${a.id}`, 'PATCH', { text });
      onSaved(r.action);
      setEditing(false);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Couldn’t save that');
    }
  };
  return (
    <div className="card hana-draft" data-testid="hana-draft" role="alertdialog" aria-label={`Draft note to ${a.draft?.to ?? 'someone'}`}>
      <b>
        A {a.draft?.kind === 'note' ? 'note' : a.draft?.kind} for {a.draft?.to}, ready when you are
      </b>
      {editing ? (
        <textarea className="draft-text" value={text} maxLength={500} rows={3} onChange={(e) => setText(e.target.value)} aria-label="Note text" data-testid="draft-text" />
      ) : (
        <p className="draft-quote">“{a.draft?.text}”</p>
      )}
      <p className="muted small">It goes to {a.draft?.to} inside MyDay only when you send it — never by email or text.</p>
      {err && <p className="error small">{err}</p>}
      <div className="confirm-actions">
        <button className="btn small ghost" onClick={() => onDecide('cancel')} data-testid="draft-discard">
          Discard
        </button>
        {editing ? (
          <button className="btn small ghost" onClick={() => void save()} data-testid="draft-save">
            Save
          </button>
        ) : (
          <button className="btn small ghost" onClick={() => setEditing(true)} data-testid="draft-edit">
            Edit
          </button>
        )}
        <button className="btn small" disabled={editing} onClick={() => onDecide('confirm')} data-testid="draft-send">
          Send
        </button>
      </div>
    </div>
  );
}

/** C3: an email or invite, drafted — the exact addresses the approval sends to, editable until then. */
export function EmailDraftCard({ a, onDecide, onSaved }: { a: HanaAction; onDecide: (verb: 'confirm' | 'cancel') => void; onSaved: (a: HanaAction) => void }) {
  const e = a.email;
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState(e?.to.join(', ') ?? '');
  const [subject, setSubject] = useState(e?.subject ?? '');
  const [body, setBody] = useState(e?.body ?? '');
  const [err, setErr] = useState<string | null>(null);
  if (!e) return null;
  const save = async (): Promise<void> => {
    try {
      const r = await api<{ action: HanaAction }>(`/api/hana/actions/${a.id}`, 'PATCH', { to: to.split(/[,\s]+/).filter(Boolean), text: body, ...(e.invite ? {} : { subject }) });
      onSaved(r.action);
      setEditing(false);
      setErr(null);
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Couldn’t save that');
    }
  };
  return (
    <div className="card hana-draft" data-testid="hana-email-draft" role="alertdialog" aria-label={`Draft ${e.invite ? 'invite' : 'email'} to ${e.to.join(', ')}`}>
      <b>{e.invite ? 'An invite' : 'An email'}, ready when you are</b>
      {editing ? (
        <>
          <input value={to} onChange={(x) => setTo(x.target.value)} aria-label="To" data-testid="email-to" />
          {!e.invite && <input value={subject} onChange={(x) => setSubject(x.target.value)} aria-label="Subject" maxLength={150} />}
          <textarea className="draft-text" value={body} rows={5} maxLength={4000} onChange={(x) => setBody(x.target.value)} aria-label="Message" />
        </>
      ) : (
        <>
          <p className="small">
            <b>To:</b> <span data-testid="email-recipients">{e.to.join(', ')}</span>
          </p>
          <p className="small">
            <b>{e.invite ? 'What:' : 'Subject:'}</b> {e.subject}
          </p>
          {e.body && <p className="draft-quote" style={{ whiteSpace: 'pre-wrap' }}>{e.body}</p>}
        </>
      )}
      <p className="muted small">Sent only when you tap Send, only to these addresses, in your name — replies come to you.</p>
      {err && <p className="error small">{err}</p>}
      <div className="confirm-actions">
        <button className="btn small ghost" onClick={() => onDecide('cancel')}>
          Discard
        </button>
        {editing ? (
          <button className="btn small ghost" onClick={() => void save()}>
            Save
          </button>
        ) : (
          <button className="btn small ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        <button className="btn small" disabled={editing} onClick={() => onDecide('confirm')} data-testid="email-send">
          Send
        </button>
      </div>
    </div>
  );
}

/** A draft from Family HQ: decided right there (the same confirm and cancel as the chat). */
export function HqDraft({ action, onDone }: { action: HanaAction; onDone: (a: HanaAction) => void }) {
  const [a, setA] = useState(action);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (verb: 'confirm' | 'cancel'): Promise<void> => {
    try {
      const r = await api<{ action: HanaAction }>(`/api/hana/actions/${a.id}/${verb}`, 'POST');
      onDone(r.action);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t go through');
    }
  };
  return (
    <>
      <DraftCard a={a} onDecide={(v) => void decide(v)} onSaved={setA} />
      {err && <p className="error small">{err}</p>}
    </>
  );
}

const FROM_KIND: Record<HanaNote['kind'], string> = { note: 'A note', encouragement: 'Some encouragement', reminder: 'A reminder' };

/** Notes from your family, delivered in MyDay. Shows nothing when there are none. */
export function HanaNotesCard() {
  const { data, setData } = useLoad<{ notes: HanaNote[] }>('/api/hana/notes');
  const fresh = data?.notes.filter((n) => !n.read) ?? [];
  if (!fresh.length) return null;
  const read = async (id: number): Promise<void> => {
    await api(`/api/hana/notes/${id}/read`, 'POST').catch(() => undefined);
    setData({ notes: (data?.notes ?? []).map((n) => (n.id === id ? { ...n, read: true } : n)) });
  };
  return (
    <div className="card hana-notes" data-testid="hana-notes">
      {fresh.map((n) => (
        <div key={n.id} className="hana-note" data-testid="hana-note">
          <small className="muted">
            {FROM_KIND[n.kind]} from {n.from ?? 'your family'}
          </small>
          <p>{n.body}</p>
          <button type="button" className="btn small ghost" onClick={() => void read(n.id)} data-testid="hana-note-read">
            Got it
          </button>
        </div>
      ))}
    </div>
  );
}

const STATUS: Record<HanaLogEntry['status'], string> = { pending: 'Waiting', done: 'Approved', cancelled: 'Discarded', failed: 'Didn’t work' };

/** Parents: everything Hana suggested, prepared and sent — who decided, and when. Forever, page by page. */
export function HanaLog() {
  const { data } = useLoad<{ log: HanaLogEntry[]; suggestions?: HanaSuggestionEntry[] }>('/api/hana/log?suggestions=1');
  const [older, setOlder] = useState<HanaLogEntry[]>([]);
  const [tab, setTab] = useState<'actions' | 'suggestions'>('actions');
  const [end, setEnd] = useState(false);
  if (!data) return null;
  const rows = [...data.log, ...older];
  const more = async (): Promise<void> => {
    const last = rows[rows.length - 1];
    if (!last) return;
    const r = await api<{ log: HanaLogEntry[] }>(`/api/hana/log?before=${last.id}`);
    setOlder([...older, ...r.log]);
    if (r.log.length < 100) setEnd(true);
  };
  const at = (iso: string): string => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <div className="card" data-testid="hq-log">
      <h2>What Hana did</h2>
      <p className="muted small">Nothing Hana prepares happens until a grown-up approves it. Anything sent in the family’s name shows for both parents.</p>
      <div className="chips" role="group" aria-label="Show">
        <button type="button" className={tab === 'actions' ? 'chip on' : 'chip'} onClick={() => setTab('actions')}>
          Prepared &amp; sent
        </button>
        <button type="button" className={tab === 'suggestions' ? 'chip on' : 'chip'} onClick={() => setTab('suggestions')}>
          Suggested
        </button>
      </div>
      {tab === 'actions' ? (
        !rows.length ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul className="hq-log">
            {rows.map((r) => (
              <li key={r.id} data-testid="hq-log-row">
                <span>
                  {r.tier === 'T2' && <span className="pill">{r.status === 'done' ? 'Sent' : 'Send'}</span>} {r.summary}
                </span>
                <small className="muted">
                  {r.proposedBy ? `for ${r.proposedBy}` : ''} · {at(r.at)} · {STATUS[r.status]}
                  {r.decidedBy ? ` by ${r.decidedBy}` : ''}
                  {r.decidedAt ? ` ${at(r.decidedAt)}` : ''}
                  {r.edited ? ' · edited' : ''}
                  {r.recipients.length ? ` · to ${r.recipients.join(', ')}` : ''}
                </small>
              </li>
            ))}
          </ul>
        )
      ) : !data.suggestions?.length ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ul className="hq-log">
          {data.suggestions.map((x) => (
            <li key={x.id}>
              <span>{x.text}</span>
              <small className="muted">
                {at(x.at)} · {x.kind}
                {x.outcome ? ` · ${x.outcome === 'acted' ? 'handled' : x.outcome === 'dismissed' ? 'set aside' : 'marked wrong'}` : ''}
              </small>
            </li>
          ))}
        </ul>
      )}
      {tab === 'actions' && rows.length >= 100 && !end && (
        <button type="button" className="link small" onClick={() => void more()}>
          Show older
        </button>
      )}
    </div>
  );
}
