import { useState } from 'react';
import { Link } from 'react-router';
import type { PrivateNote } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { when } from '../../dates';

/** A teen's private space: notes only they can read (not parents, not Hana), plus shortcuts to their money and look. */
export default function Private() {
  const confirm = useConfirm();
  const { data, setData } = useLoad<{ notes: PrivateNote[] }>('/api/private-notes');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <section>
      <h1>My space</h1>
      <p className="muted small">Only you can see these notes. Not parents, not Hana.</p>
      <div className="row">
        <Link className="btn small ghost" to="/my-money">
          My money
        </Link>
        <Link className="btn small ghost" to="/settings">
          Theme
        </Link>
        <Link className="btn small ghost" to="/focus">
          Focus timer
        </Link>
      </div>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void api<{ notes: PrivateNote[] }>('/api/private-notes', 'POST', { body })
            .then((d) => {
              setData(d);
              setBody('');
              setMsg('Saved ✓');
            })
            .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not save'));
        }}
      >
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write anything…" maxLength={4000} required />
        <button className="btn small">Save note</button>
      </form>
      {msg && <p className="muted small">{msg}</p>}
      <ul className="plain" data-testid="private-notes">
        {data?.notes.map((n) => (
          <li key={n.id} className="card">
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{n.body}</p>
            <div className="row">
              <small className="muted grow">{when(n.at)}</small>
              <button
                className="link danger"
                onClick={() =>
                  void confirm({ title: 'Delete this note?', confirmLabel: 'Delete', danger: true }).then(
                    (y) => void (y && api<{ notes: PrivateNote[] }>(`/api/private-notes/${n.id}`, 'DELETE').then(setData)),
                  )
                }
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
