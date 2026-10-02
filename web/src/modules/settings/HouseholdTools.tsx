import { useState } from 'react';
import type { AdminDashboard, InviteCreated, MergePreview } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import QR from '../../components/QR';
import { useSession } from '../../session';

/** Invite a grown-up: email in, link + QR out (valid 14 days). Works for someone already on the roster too. */
export function InviteGrownUp() {
  const { members } = useSession();
  const [who, setWho] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [made, setMade] = useState<InviteCreated | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const adults = members.filter((m) => m.kind === 'adult');
  const send = async (): Promise<void> => {
    setErr(null);
    try {
      setMade(
        await api<InviteCreated>('/api/household/invites', 'POST', {
          email,
          ...(who ? { memberId: Number(who) } : { name }),
        }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the invite');
    }
  };
  return (
    <div className="card" data-testid="invite-grown-up">
      <h2>Invite a grown-up</h2>
      <p className="small muted">They sign in with Google and land in this household — no duplicate household.</p>
      <div className="form">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who are you inviting">
          <option value="">Someone new</option>
          {adults.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} (already on the roster)
            </option>
          ))}
        </select>
        {!who && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their first name" maxLength={40} aria-label="Their first name" />}
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their Google email" type="email" aria-label="Their Google email" />
        <button className="btn small" disabled={!email || (!who && !name)} onClick={() => void send()}>
          Create invite
        </button>
        {err && <p className="error">{err}</p>}
      </div>
      {made && (
        <div data-testid="invite-made" style={{ marginTop: 10 }}>
          <QR value={made.link} label="Invite QR code" />
          <p className="small" style={{ wordBreak: 'break-all' }}>
            {made.link}
          </p>
          <p className="small muted">Works once, for 14 days. Opening it signs them in straight into this household.</p>
          <button className="btn small ghost" onClick={() => void navigator.clipboard?.writeText(made.link)}>
            Copy link
          </button>
        </div>
      )}
    </div>
  );
}

/** Staff: fold a duplicate household (e.g. a partner who signed up alone) into this one. */
export function MergeDuplicate() {
  const { me } = useSession();
  const confirm = useConfirm();
  const dash = useLoad<AdminDashboard>('/api/admin/dashboard');
  const [from, setFrom] = useState('');
  const [p, setP] = useState<MergePreview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const mine = me.household?.id;
  if (!mine || !dash.data) return null;
  const others = dash.data.households.filter((h) => h.id !== mine);
  const look = async (id: string): Promise<void> => {
    setFrom(id);
    setP(null);
    if (id) setP(await api<MergePreview>(`/api/admin/households/${id}/merge-preview?into=${mine}`));
  };
  const merge = async (): Promise<void> => {
    if (!p) return;
    const ok = await confirm({
      title: `Merge “${p.from.name}” into ${p.into.name}?`,
      body: `${[...p.folding.map((f) => `${f.name} becomes the existing ${f.into}`), ...p.moving.map((m) => `${m.name} moves in`)].join('; ') || 'No people'}. Everything else moves too, then “${p.from.name}” is deleted. This is logged.`,
      confirmLabel: 'Merge',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/admin/households/${p.from.id}/merge`, 'POST', { into: mine, confirm: p.from.name });
      setMsg(`Merged ${p.from.name} into ${p.into.name}.`);
      setP(null);
      setFrom('');
      dash.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not merge');
    }
  };
  return (
    <div className="card" data-testid="merge-duplicate">
      <h2>Merge a duplicate household</h2>
      <p className="small muted">Staff tool. Pick the duplicate; you’ll see exactly what moves before anything happens.</p>
      <select value={from} onChange={(e) => void look(e.target.value)} aria-label="Duplicate household">
        <option value="">Pick a household…</option>
        {others.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name} · {h.members} people · since {h.createdAt.slice(0, 10)}
          </option>
        ))}
      </select>
      {p && (
        <div data-testid="merge-preview" className="small" style={{ marginTop: 8 }}>
          {p.folding.map((f) => (
            <p key={f.name}>↪ {f.name} becomes the existing {f.into}</p>
          ))}
          {p.moving.map((m) => (
            <p key={m.name}>
              → {m.name} ({m.kind}) moves in
            </p>
          ))}
          <p className="muted">{Object.entries(p.rows).map(([t, n]) => `${t.replace(/_/g, ' ')} ${n}`).join(' · ') || 'No other records'}</p>
          <button className="btn small danger" onClick={() => void merge()}>
            Merge into {p.into.name}
          </button>
        </div>
      )}
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}
