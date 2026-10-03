import { useState, type FormEvent } from 'react';
import type {
  HouseholdAdminResponse,
  InviteCreated,
  MemberFields,
  MemberKind,
  NewInvite,
  RosterMember,
  XpTrack,
} from '@myday/shared';
import { api, useLoad } from '../../api';
import { useToast } from '../../components/useToast';
import { useSession } from '../../session';
import KidAccess from '../kids/KidAccess';
import { useConfirm } from '../../components/Confirm';
import RoleArt, { roleIcon } from '../../components/RoleArt';
import { ago } from '../../dates';

const TRACK_LABEL: Record<XpTrack, string> = {
  leader: 'Family Leader',
  woman: 'Heart of Home',
  student: 'Student',
  kid: 'Kid',
};

function MemberRow({ m, onSave, onArchive, onRestore }: {
  m: RosterMember;
  onSave: (f: Partial<MemberFields>) => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const { me } = useSession();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState<MemberFields>({ name: m.name, kind: m.kind, age: m.age, xpTrack: m.xpTrack, email: m.email });
  if (m.archived) {
    return (
      <li className="muted">
        <span>
          {m.name} <small>· removed</small>
        </span>
        <button className="link" onClick={onRestore}>
          Restore
        </button>
      </li>
    );
  }
  if (!edit) {
    return (
      <li>
        <RoleArt src={roleIcon(m.kind, m.xpTrack, me.household?.type)} />
        <span className="grow">
          <b>{m.name}</b>
          {m.isYou && <span className="tag">YOU</span>}
          <small className="muted">
            {' '}
            · {TRACK_LABEL[m.xpTrack]}
            {m.age !== null && ` · ${m.age}`}
            {m.email && ` · ${m.email}`}
            {m.invite && ` · invite ${m.invite.status}`}
            {m.kind === 'kid' && (m.hasPin ? ' · PIN set' : ' · no PIN')}
          </small>
        </span>
        <span>
          <button className="link" onClick={() => setEdit(true)}>
            Edit
          </button>
          {!m.isYou && (
            <button className="link danger" onClick={onArchive}>
              Remove
            </button>
          )}
        </span>
      </li>
    );
  }
  return (
    <li>
      <form
        className="form wide"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(f);
          setEdit(false);
        }}
      >
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Name" />
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value === 'kid' ? 'kid' : 'adult' })} aria-label="Kid or grown-up">
          <option value="adult">Grown-up</option>
          <option value="kid">Kid</option>
        </select>
        <select value={f.xpTrack} onChange={(e) => setF({ ...f, xpTrack: (Object.keys(TRACK_LABEL) as XpTrack[]).find((t) => t === e.target.value) ?? f.xpTrack })} aria-label="Level track">
          {(Object.keys(TRACK_LABEL) as XpTrack[]).map((t) => (
            <option key={t} value={t}>
              {TRACK_LABEL[t]}
            </option>
          ))}
        </select>
        <input type="number" min={0} value={f.age ?? ''} placeholder="age" onChange={(e) => setF({ ...f, age: e.target.value ? Number(e.target.value) : null })} aria-label="Age" />
        <input type="email" value={f.email ?? ''} placeholder="Google email (grown-ups)" onChange={(e) => setF({ ...f, email: e.target.value || null })} aria-label="Email" />
        <span>
          <button className="btn small">Save</button>{' '}
          <button type="button" className="link" onClick={() => setEdit(false)}>
            Cancel
          </button>
        </span>
      </form>
    </li>
  );
}

/** Who's in the family, their roles, invites, kid PINs and kid devices. */
export default function Household() {
  const { isAdult } = useSession();
  const { data, error, setData } = useLoad<HouseholdAdminResponse>(isAdult ? '/api/household/admin' : null);
  const { toast, show } = useToast();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<MemberKind>('kid');
  const [age, setAge] = useState('');
  const [inv, setInv] = useState<NewInvite>({ name: '', email: '', xpTrack: 'woman' });
  const [link, setLink] = useState<string | null>(null);
  const [deviceKids, setDeviceKids] = useState<number[]>([]);
  const confirm = useConfirm();

  if (!isAdult) return <p className="muted">Only grown-ups can manage the household.</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const run = async (p: Promise<HouseholdAdminResponse>, msg: string): Promise<void> => {
    try {
      setData(await p);
      show(msg);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const add = (e: FormEvent): void => {
    e.preventDefault();
    void run(api<HouseholdAdminResponse>('/api/household/members', 'POST', { name, kind, age: age ? Number(age) : null }), `${name} added`).then(() => {
      setName('');
      setAge('');
    });
  };
  const invite = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    try {
      const r = await api<InviteCreated>('/api/household/invites', 'POST', inv);
      setLink(r.link);
      setData(await api<HouseholdAdminResponse>('/api/household/admin'));
      setInv({ ...inv, name: '', email: '' });
    } catch (err) {
      show(err instanceof Error ? err.message : 'Could not invite');
    }
  };
  const kids = data.members.filter((m) => m.kind === 'kid' && !m.archived);

  return (
    <section>
      <h1>Household</h1>
      <ul className="plain rows" data-testid="roster">
        {data.members.map((m) => (
          <MemberRow
            key={m.id}
            m={m}
            onSave={(f) => void run(api<HouseholdAdminResponse>(`/api/household/members/${m.id}`, 'PATCH', f), 'Saved')}
            onArchive={() =>
              void confirm({
                title: `Remove ${m.name}?`,
                body: "Their history stays; they can't sign in. You can restore them later.",
                confirmLabel: 'Remove',
                danger: true,
              }).then((ok) => { if (ok) void run(api<HouseholdAdminResponse>(`/api/household/members/${m.id}/archive`, 'POST'), `${m.name} removed`); })
            }
            onRestore={() => void run(api<HouseholdAdminResponse>(`/api/household/members/${m.id}/restore`, 'POST'), `${m.name} restored`)}
          />
        ))}
      </ul>

      <form className="card form" onSubmit={add}>
        <h2>Add someone</h2>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="First name" required />
        <div className="chips">
          <button type="button" className={kind === 'kid' ? 'chip on' : 'chip'} onClick={() => setKind('kid')}>
            Kid
          </button>
          <button type="button" className={kind === 'adult' ? 'chip on' : 'chip'} onClick={() => setKind('adult')}>
            Grown-up
          </button>
        </div>
        <input type="number" min={0} value={age} onChange={(e) => setAge(e.target.value)} placeholder="Age (optional)" />
        <button className="btn">Add</button>
      </form>

      <form className="card form" onSubmit={(e) => void invite(e)}>
        <h2>Invite a grown-up</h2>
        <p className="muted">They sign in with this Google account. You'll get a link to send them.</p>
        <input value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} placeholder="Name" required />
        <input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} placeholder="their@gmail.com" required />
        <select aria-label="Level track" value={inv.xpTrack} onChange={(e) => setInv({ ...inv, xpTrack: (['leader', 'woman', 'student'] as const).find((t) => t === e.target.value) ?? 'leader' })}>
          <option value="leader">Family Leader</option>
          <option value="woman">Heart of Home</option>
          <option value="student">Student</option>
        </select>
        <button className="btn">Create invite</button>
        {link && (
          <div className="card current" data-testid="invite-link">
            <small className="muted">Send this link (shown once):</small>
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
          </div>
        )}
      </form>

      <KidAccess />

      <div className="card">
        <h2>Kid sign-in devices</h2>
        <p className="muted">A family tablet or a kid's phone can remember kids, so they just tap their name and type their PIN.</p>
        <ul className="plain rows">
          {data.devices.map((d) => (
            <li key={d.id}>
              <span>
                {d.label || 'Device'} {d.isThisDevice && <span className="tag">THIS ONE</span>}
                <small className="muted">
                  {' '}
                  · {d.kids.join(', ') || 'no kids'} · seen {ago(d.lastSeenAt)}
                </small>
              </span>
              <button className="link danger" onClick={() => void run(api<HouseholdAdminResponse>(`/api/household/devices/${d.id}`, 'DELETE'), 'Device forgotten')}>
                Forget
              </button>
            </li>
          ))}
        </ul>
        <div className="chips">
          {kids.map((k) => (
            <button
              key={k.id}
              className={deviceKids.includes(k.id) ? 'chip on' : 'chip'}
              onClick={() => setDeviceKids(deviceKids.includes(k.id) ? deviceKids.filter((x) => x !== k.id) : [...deviceKids, k.id])}
            >
              {k.name}
            </button>
          ))}
        </div>
        <button
          className="btn small"
          disabled={!deviceKids.length}
          onClick={() => void run(api<HouseholdAdminResponse>('/api/household/devices/this', 'POST', { memberIds: deviceKids }), 'This device now remembers them')}
        >
          Set up this device for them
        </button>
      </div>
      {toast}
    </section>
  );
}
