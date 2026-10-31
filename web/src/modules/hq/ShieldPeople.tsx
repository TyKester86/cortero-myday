/**
 * Q9 in Family HQ: JP6 the shield (warnings to mark fine or a scam — nothing is ever blocked) and
 * JP5 the family's people, each with a dossier and the role card of what they need to know.
 */
import { useState, type FormEvent } from 'react';
import type { PeopleView, PersonDossier, PersonRole, ShieldAlert } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';

const KIND: Record<ShieldAlert['kind'], string> = {
  impersonation: 'Family-emergency scam?',
  phishing: 'Phishing?',
  kid_target: 'Aimed at a kid?',
  account_security: 'Security alert',
  money: 'New charge',
};

export function ShieldCard() {
  const { data, setData } = useLoad<{ alerts: ShieldAlert[] }>('/api/shield');
  if (!data) return null;
  const decide = async (a: ShieldAlert, v: 'fine' | 'scam'): Promise<void> => {
    await api(`/api/shield/${a.id}/${v}`, 'POST');
    setData({ alerts: data.alerts.filter((x) => x.id !== a.id) });
  };
  return (
    <div className="card shield" data-testid="hq-shield">
      <h2>Scam & safety watch</h2>
      <p className="muted small">Hana warns; she never blocks or deletes anything. Every message stays in the inbox.</p>
      {!data.alerts.length && <p className="muted">Nothing suspicious right now.</p>}
      <ul className="plain rows">
        {data.alerts.map((a) => (
          <li key={a.id} className={`shield-alert ${a.kind}`} data-testid="shield-alert">
            <span>
              <b>{KIND[a.kind]}</b> {a.text}
            </span>
            <span className="mem-tools">
              <button className="link small" onClick={() => void decide(a, 'fine')} data-testid="shield-fine">
                It’s fine
              </button>
              {a.kind !== 'account_security' && (
                <button className="link danger small" onClick={() => void decide(a, 'scam')} data-testid="shield-scam">
                  It’s a scam
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ROLES: Array<[PersonRole, string]> = [
  ['teacher', 'Teacher'],
  ['doctor', 'Doctor'],
  ['coach', 'Coach'],
  ['kin', 'Family'],
  ['sitter', 'Sitter'],
  ['other', 'Other'],
];

function Dossier({ id }: { id: number }) {
  const { data } = useLoad<PersonDossier>(`/api/people/${id}`);
  const [copied, setCopied] = useState(false);
  if (!data) return <p className="muted small">Reading…</p>;
  const copy = (): void => {
    if (!data.shareCard) return;
    navigator.clipboard.writeText(data.shareCard).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="dossier" data-testid="dossier">
      <p className="small">
        {data.lastContact ? `Last contact: ${data.lastContact.date} (${data.lastContact.how}) — ${data.lastContact.what}` : 'No contact on record yet.'}
      </p>
      {data.openLoops.length > 0 && <p className="small">Open with them: {data.openLoops.map((l) => `${l.what}${l.due ? ` (due ${l.due})` : ''}`).join('; ')}</p>}
      {data.upcoming.length > 0 && <p className="small">Coming up: {data.upcoming.map((u) => `${u.title} ${u.date}`).join('; ')}</p>}
      {data.shareCard ? (
        <>
          <pre className="share-card" data-testid="dossier-card">
            {data.shareCard}
          </pre>
          <button className="btn small ghost" onClick={copy}>
            {copied ? 'Copied' : 'Copy to share'}
          </button>
        </>
      ) : (
        <p className="muted small">Nothing on file their role needs yet.</p>
      )}
    </div>
  );
}

export function PeopleCard() {
  const { members } = useSession();
  const { data, reload } = useLoad<PeopleView>('/api/people');
  const [open, setOpen] = useState<number | null>(null);
  const [f, setF] = useState({ name: '', role: 'teacher' as PersonRole, email: '', phone: '', forId: '' });
  const [err, setErr] = useState<string | null>(null);
  if (!data) return null;
  const add = async (e: FormEvent | null, pre?: { name: string; email: string; role: PersonRole }): Promise<void> => {
    e?.preventDefault();
    const b = pre ?? f;
    setErr(null);
    try {
      await api('/api/people', 'POST', { name: b.name.trim(), role: b.role, email: b.email.trim(), phone: pre ? '' : f.phone.trim(), forIds: !pre && f.forId ? [Number(f.forId)] : [] });
      if (!pre) setF({ name: '', role: 'teacher', email: '', phone: '', forId: '' });
      reload();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Couldn’t add them');
    }
  };
  return (
    <div className="card people" data-testid="hq-people">
      <h2>The family’s people</h2>
      <p className="muted small">Teachers, doctors, coaches, family and sitters — what’s open with each, and only what their role needs to know. It never leaves the family unless you send it.</p>
      <ul className="plain rows">
        {data.people.map((p) => (
          <li key={p.id} data-testid="person">
            <div className="row">
              <button className="link grow" onClick={() => setOpen(open === p.id ? null : p.id)}>
                <b>{p.name}</b> <span className="muted small">· {ROLES.find(([r]) => r === p.role)?.[1]}{p.forNames.length ? ` for ${p.forNames.join(', ')}` : ''}</span>
              </button>
              <button className="link danger small" onClick={() => void api(`/api/people/${p.id}`, 'DELETE').then(reload)}>
                Remove
              </button>
            </div>
            {open === p.id && <Dossier id={p.id} />}
          </li>
        ))}
      </ul>
      {data.suggestions.length > 0 && (
        <>
          <h3 className="ing-head">Hana noticed</h3>
          <ul className="plain rows">
            {data.suggestions.map((s) => (
              <li key={`${s.name}:${s.email}`} data-testid="person-suggestion">
                <span>
                  {s.name} <small className="muted">· {s.why}</small>
                </span>
                <button className="link small" onClick={() => void add(null, s)}>
                  Add
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <form className="inline wrap" onSubmit={(e) => void add(e)}>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name" aria-label="Person’s name" />
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as PersonRole })} aria-label="Role">
          {ROLES.map(([r, l]) => (
            <option key={r} value={r}>
              {l}
            </option>
          ))}
        </select>
        <select value={f.forId} onChange={(e) => setF({ ...f, forId: e.target.value })} aria-label="For whom">
          <option value="">For…</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="Email" aria-label="Email" />
        <button className="btn small ghost" disabled={!f.name.trim()} data-testid="person-add">
          Add
        </button>
      </form>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}
