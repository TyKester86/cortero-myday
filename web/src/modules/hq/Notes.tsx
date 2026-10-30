/**
 * H6 in the app: drafted notes (edit, send or discard), notes delivered to you, and the
 * parents' audit log of everything Hana prepared — who approved or discarded it, and when.
 */
import { useState } from 'react';
import type { HanaAction, HanaLogEntry, HanaNote } from '@myday/shared';
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

/** Parents: what Hana prepared, and who decided. */
export function HanaLog() {
  const { data } = useLoad<{ log: HanaLogEntry[] }>('/api/hana/log');
  const [all, setAll] = useState(false);
  if (!data) return null;
  const rows = all ? data.log : data.log.slice(0, 8);
  return (
    <div className="card" data-testid="hq-log">
      <h2>What Hana prepared</h2>
      <p className="muted small">Nothing Hana prepares happens until a grown-up approves it. Notes to anyone in the family show for both parents.</p>
      {!rows.length ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ul className="hq-log">
          {rows.map((r) => (
            <li key={r.id} data-testid="hq-log-row">
              <span>{r.summary}</span>{' '}
              <small className="muted">
                {r.proposedBy ? `for ${r.proposedBy}` : ''} · {STATUS[r.status]}
                {r.decidedBy ? ` by ${r.decidedBy}` : ''}
                {r.decidedAt ? ` ${new Date(r.decidedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
                {r.edited ? ' · edited' : ''}
              </small>
            </li>
          ))}
        </ul>
      )}
      {data.log.length > 8 && (
        <button type="button" className="link small" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${data.log.length}`}
        </button>
      )}
    </div>
  );
}
