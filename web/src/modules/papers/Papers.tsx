/**
 * C5: Papers — the family's forms and documents in one place, and the household vault.
 * Hana reads each one (what, whose, what's needed, by when), fills in what the household already
 * holds when you ask, and never signs. The vault keeps numbers sealed and expiries ahead of time.
 */
import { useRef, useState, type FormEvent } from 'react';
import type { HanaAction, PaperDoc, VaultItem } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { useSession } from '../../session';
import { shrink } from '../health/ProgressPhotos';

const KIND: Record<PaperDoc['kind'], string> = { form: 'Form', permission_slip: 'Permission slip', medical: 'Medical', insurance: 'Insurance', registration: 'Registration', other: 'Document' };
const VKIND: Record<VaultItem['kind'], string> = { drivers_license: 'Driver’s license', passport: 'Passport', insurance_card: 'Insurance card', registration: 'Registration', warranty: 'Warranty', id_card: 'ID card', other: 'Other' };

async function upload(file: File, photo: boolean): Promise<PaperDoc> {
  let body: Blob = file;
  let type = file.type || 'application/octet-stream';
  if (file.type.startsWith('image/') && file.type !== 'image/gif') {
    try {
      body = await shrink(file);
      type = 'image/jpeg';
    } catch {
      /* send it as it is */
    }
  }
  const res = await fetch(`/api/papers/upload?name=${encodeURIComponent(file.name)}${photo ? '&photo=1' : ''}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': type, 'X-MyDay-Upload': '1' }, body });
  const out = (await res.json().catch(() => null)) as { doc?: PaperDoc; error?: string } | null;
  if (!res.ok || !out?.doc) throw new Error(out?.error ?? 'Couldn’t add that');
  return out.doc;
}

function FillCard({ action, onDone }: { action: HanaAction; onDone: () => void }) {
  const f = action.fill;
  const [err, setErr] = useState<string | null>(null);
  if (!f) return null;
  const decide = async (verb: 'confirm' | 'cancel'): Promise<void> => {
    try {
      await api(`/api/hana/actions/${action.id}/${verb}`, 'POST');
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t go through');
    }
  };
  return (
    <div className="card hana-draft" data-testid="paper-fill" role="alertdialog" aria-label={`Fill in ${f.title}`}>
      <b>Hana’s fill-in for “{f.title}”</b>
      <table className="paper-fill">
        <tbody>
          {f.values.map((v) => (
            <tr key={v.label}>
              <th>{v.label}</th>
              <td>
                {v.value ?? <span className="muted">{v.from ?? 'Not in MyDay — you fill this'}</span>}
                {v.value && v.from && <small className="muted"> · {v.from}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Nothing is saved until you OK it. She never signs — that’s yours.</p>
      {err && <p className="error small">{err}</p>}
      <div className="confirm-actions">
        <button className="btn small ghost" onClick={() => void decide('cancel')}>
          Discard
        </button>
        <button className="btn small" onClick={() => void decide('confirm')} data-testid="paper-fill-ok">
          Use this
        </button>
      </div>
    </div>
  );
}

function DocCard({ d, onChange }: { d: PaperDoc; onChange: () => void }) {
  const { members } = useSession();
  const [fill, setFill] = useState<HanaAction | null>(null);
  const [editing, setEditing] = useState(d.readBy === 'person' && d.title.startsWith('A document'));
  const [title, setTitle] = useState(d.title);
  const [about, setAbout] = useState(d.about ?? '');
  const [deadline, setDeadline] = useState(d.deadline ?? '');
  const [fields, setFields] = useState(d.fields.join(', '));
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t go through');
    }
  };
  return (
    <li className="card paper" data-testid="paper">
      <div className="row">
        <span className="pill">{KIND[d.kind]}</span>
        <b className="grow">{d.title}</b>
        {d.done && <span className="pill">Done</span>}
      </div>
      <small className="muted">
        {d.about ? `${d.about} · ` : ''}
        {d.needed || 'Nothing asked'}
        {d.deadline ? ` · by ${d.deadline}` : ''} · {d.source === 'email' ? 'by email' : d.source === 'photo' ? 'a photo' : 'uploaded'}
        {d.readBy === 'ai' ? ' · read by Hana' : d.readBy === 'rules' ? ' · read by Hana (simple reading)' : ''}
      </small>
      {d.fields.length > 0 && <small className="muted">Blanks: {d.fields.join(', ')}</small>}
      {editing ? (
        <form
          className="cal-source-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/api/papers/${d.id}`, 'PATCH', { title, about: about || null, deadline: deadline || null, fields: fields.split(',').map((x) => x.trim()).filter(Boolean) });
              setEditing(false);
              onChange();
            });
          }}
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="What it is" maxLength={120} />
          <label>
            Whose{' '}
            <select value={about} onChange={(e) => setAbout(e.target.value)}>
              <option value="">The family</option>
              {members.map((m) => (
                <option key={m.key} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            By <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
          <input value={fields} onChange={(e) => setFields(e.target.value)} placeholder="Blanks, comma-separated (Student name, Parent signature…)" aria-label="Blanks" />
          <span className="row">
            <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn small">Save</button>
          </span>
        </form>
      ) : null}
      {fill && <FillCard action={fill} onDone={() => (setFill(null), onChange())} />}
      {err && <p className="error small">{err}</p>}
      {!d.done && (
        <div className="row">
          {d.hasFile && (
            <a className="btn small ghost" href={`/api/papers/${d.id}/file`} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
          {!editing && (
            <button type="button" className="btn small ghost" onClick={() => setEditing(true)}>
              Correct
            </button>
          )}
          {d.fields.length > 0 && !fill && (
            <button type="button" className="btn small ghost" onClick={() => void run(async () => setFill((await api<{ action: HanaAction }>(`/api/papers/${d.id}/fill`, 'POST')).action))} data-testid="paper-fill-btn">
              Fill it in
            </button>
          )}
          {d.completion && (
            <a className="btn small ghost" href={`/api/papers/${d.id}/filled`} target="_blank" rel="noreferrer" data-testid="paper-filled">
              Filled copy to sign
            </a>
          )}
          <button type="button" className="btn small" onClick={() => void run(async () => (await api(`/api/papers/${d.id}/done`, 'POST'), onChange()))} data-testid="paper-done">
            Done
          </button>
        </div>
      )}
    </li>
  );
}

function Vault({ items, onChange }: { items: VaultItem[]; onChange: () => void }) {
  const { members } = useSession();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ kind: 'drivers_license' as VaultItem['kind'], label: '', holder: '', issuer: '', number: '', expires: '' });
  const [shown, setShown] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    try {
      await api('/api/vault', 'POST', { ...f, holder: f.holder || null, expires: f.expires || null });
      setAdding(false);
      setF({ kind: 'drivers_license', label: '', holder: '', issuer: '', number: '', expires: '' });
      onChange();
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Couldn’t save that');
    }
  };
  return (
    <div className="card" data-testid="vault">
      <h2>The vault</h2>
      <p className="muted small">Licenses, passports, insurance cards, registrations, warranties. Numbers are sealed and shown masked; Hana says when one is coming up for renewal.</p>
      <ul className="hq-log">
        {items.map((v) => (
          <li key={v.id} className={v.expiring ? 'loop today' : 'loop'} data-testid="vault-item">
            <span>
              <b>{v.label}</b> <small className="muted">{VKIND[v.kind]}{v.holder ? ` · ${v.holder}` : ''}{v.issuer ? ` · ${v.issuer}` : ''}</small>
            </span>
            <small className="muted">
              {shown[v.id] ?? v.masked ?? 'No number'}
              {v.expires ? ` · expires ${v.expires}${v.daysLeft !== null && v.daysLeft < 0 ? ' (expired)' : v.expiring ? ` (in ${v.daysLeft} days)` : ''}` : ''}
            </small>
            <span className="row">
              {v.masked && !shown[v.id] && (
                <button type="button" className="link small" onClick={() => void api<{ number: string }>(`/api/vault/${v.id}/reveal`, 'POST').then((r) => setShown({ ...shown, [v.id]: r.number }))}>
                  Show number
                </button>
              )}
              <button
                type="button"
                className="link small"
                onClick={() => void confirm({ title: `Remove ${v.label}?`, confirmLabel: 'Remove', danger: true }).then((y) => void (y && api(`/api/vault/${v.id}`, 'DELETE').then(onChange)))}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      {!items.length && <p className="muted">Nothing in the vault yet.</p>}
      {err && <p className="error small">{err}</p>}
      {!adding ? (
        <button type="button" className="btn small" onClick={() => setAdding(true)} data-testid="vault-add">
          + Add to the vault
        </button>
      ) : (
        <form className="cal-source-form" onSubmit={(e) => void add(e)}>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as VaultItem['kind'] })} aria-label="What kind">
            {Object.entries(VKIND).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Name, e.g. Ty’s passport" required maxLength={80} aria-label="Name" />
          <select value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} aria-label="Whose">
            <option value="">The family</option>
            {members.map((m) => (
              <option key={m.key} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
          <input value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} placeholder="Issuer (state, insurer, store)" maxLength={80} aria-label="Issuer" />
          <input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} placeholder="Number (sealed; shown masked)" maxLength={80} aria-label="Number" autoComplete="off" />
          <label>
            Expires <input type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} />
          </label>
          <span className="row">
            <button type="button" className="btn small ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn small">Save</button>
          </span>
        </form>
      )}
    </div>
  );
}

export default function Papers() {
  const { data, reload } = useLoad<{ papers: PaperDoc[]; vault: VaultItem[] }>('/api/papers');
  const file = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <p className="muted">Loading…</p>;
  const take = async (list: FileList | null, photo: boolean): Promise<void> => {
    const f = list?.[0];
    if (!f) return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await upload(f, photo);
      setMsg(d.readBy === 'person' ? 'Saved — Hana couldn’t read this one, so say what it is (Correct).' : `Read: ${d.title}${d.deadline ? `, by ${d.deadline}` : ''}.`);
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Couldn’t add that');
    } finally {
      setBusy(false);
    }
  };
  const open = data.papers.filter((d) => !d.done);
  const done = data.papers.filter((d) => d.done);
  return (
    <section data-testid="papers">
      <h1>Papers</h1>
      <p className="muted">School forms, permission slips, medical and insurance papers, registrations — one place. Hana reads each, fills what she can, and never signs.</p>
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={() => camera.current?.click()}>
          Take a photo
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => file.current?.click()}>
          Add a file
        </button>
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void take(e.target.files, true)} />
        <input ref={file} type="file" accept="image/*,application/pdf,text/plain" hidden onChange={(e) => void take(e.target.files, false)} data-testid="paper-file" />
      </div>
      <p className="muted small">Or forward it to Hana’s email address (on the Inbox page).</p>
      {busy && <p className="muted">Reading…</p>}
      {msg && <p className="muted small" role="status">{msg}</p>}
      <ul className="papers-list">
        {open.map((d) => (
          <DocCard key={d.id} d={d} onChange={reload} />
        ))}
      </ul>
      {!open.length && <p className="muted">Nothing waiting.</p>}
      {done.length > 0 && (
        <details>
          <summary>Done ({done.length})</summary>
          <ul className="papers-list">
            {done.map((d) => (
              <DocCard key={d.id} d={d} onChange={reload} />
            ))}
          </ul>
        </details>
      )}
      <Vault items={data.vault} onChange={reload} />
    </section>
  );
}
