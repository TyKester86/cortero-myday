import { useState } from 'react';
import {
  CARE_KIND_LABEL,
  CARE_KINDS,
  CARE_SCOPE_LABEL,
  CARE_SCOPES,
  MH_SCOPES,
  type CareGrant,
  type CareGrantDetail,
  type CareKind,
  type CareScope,
  type ProClient,
  type ProProfile,
  type ProScopeData,
} from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { useSession } from '../../session';

function GrantDetail({ id }: { id: number }) {
  const { data, setData } = useLoad<CareGrantDetail>(`/api/care/grants/${id}`);
  const [note, setNote] = useState('');
  if (!data) return <p className="muted small">Loading…</p>;
  return (
    <div data-testid="care-detail">
      <h3>Notes</h3>
      {data.grant.kind === 'mental_health' && <p className="small muted">Private: only you and your provider can read these.</p>}
      {data.notes.map((n) => (
        <p key={n.id} className="small">
          <b>{n.author}</b> · {n.at.slice(0, 10)} — {n.body}
        </p>
      ))}
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void api<CareGrantDetail>(`/api/care/grants/${id}/notes`, 'POST', { body: note }).then((d) => {
            setData(d);
            setNote('');
          });
        }}
      >
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the provider…" aria-label="Note" />
        <button className="btn small">Add</button>
      </form>
      <h3>Access log</h3>
      <ul className="plain small" data-testid="care-log">
        {data.log.map((l, i) => (
          <li key={i}>
            {new Date(l.at).toLocaleString()} · <b>{l.who}</b> {l.action}
            {l.scope && ` ${l.scope}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Family side: who's on the care team, what they can see, invite links, revoke, notes, the access log. */
export default function Care() {
  const { members, me } = useSession();
  const confirm = useConfirm();
  const { data, error, setData } = useLoad<{ grants: CareGrant[] }>('/api/care');
  const [form, setForm] = useState<{ kind: CareKind; subject: string; scopes: CareScope[]; label: string }>({ kind: 'tutor', subject: '', scopes: ['homework'], label: '' });
  const [created, setCreated] = useState<CareGrant | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const mh = form.kind === 'mental_health';
  const allowed = mh ? MH_SCOPES : [...CARE_SCOPES];
  const subjectKey = mh ? (me.member?.key ?? '') : form.subject;
  const reload = async (): Promise<void> => setData(await api<{ grants: CareGrant[] }>('/api/care'));

  return (
    <section>
      <h1>Care team</h1>
      <p className="muted small">Tutors, coaches and providers see only what you share, only while you allow it. Every look is logged.</p>
      {msg && <p className="muted" role="status">{msg}</p>}
      <div data-testid="care-grants">
        {data.grants.length === 0 && <p className="muted">No one yet.</p>}
        {data.grants.map((g) => (
          <div key={g.id} className="card">
            <div className="row">
              <span className="grow">
                <b>{g.pro ?? 'Invite not accepted yet'}</b> · {CARE_KIND_LABEL[g.kind]} for {g.subject}
                {g.label && <small className="muted"> · {g.label}</small>}
              </span>
              <span className={g.status === 'active' ? 'pill good' : 'pill'}>{g.status}</span>
            </div>
            <p className="small">Can see: {g.scopes.map((s) => CARE_SCOPE_LABEL[s]).join(', ')}</p>
            <div className="row">
              {g.canSeeNotes && (
                <button className="link" onClick={() => setOpen(open === g.id ? null : g.id)}>
                  {open === g.id ? 'Hide notes & log' : 'Notes & access log'}
                </button>
              )}
              {g.status !== 'revoked' && (
                <button
                  className="link danger"
                  onClick={() =>
                    void confirm({ title: `Revoke ${g.pro ?? 'this invite'}?`, body: 'Their access ends immediately.', confirmLabel: 'Revoke', danger: true }).then(
                      (y) =>
                        void (y &&
                          api<{ grants: CareGrant[] }>(`/api/care/grants/${g.id}/revoke`, 'POST').then((d) => {
                            setData(d);
                            setMsg('Access revoked');
                          })),
                    )
                  }
                >
                  Revoke
                </button>
              )}
            </div>
            {open === g.id && <GrantDetail id={g.id} />}
          </div>
        ))}
      </div>

      <div className="card" data-testid="care-invite">
        <h2>Add someone</h2>
        <div className="form">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as CareKind, scopes: e.target.value === 'mental_health' ? ['checkins'] : ['homework'] })} aria-label="Kind">
            {CARE_KINDS.map((k) => (
              <option key={k} value={k}>
                {CARE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          {mh ? (
            <p className="small muted">For you only. Nobody else in the household can see this provider, the notes or the log.</p>
          ) : (
            <select value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} aria-label="For whom">
              <option value="">Who will they work with?</option>
              {members.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          <div className="chips">
            {allowed.map((s) => (
              <button
                type="button"
                key={s}
                className={form.scopes.includes(s) ? 'chip on' : 'chip'}
                onClick={() => setForm({ ...form, scopes: form.scopes.includes(s) ? form.scopes.filter((x) => x !== s) : [...form.scopes, s] })}
              >
                {CARE_SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Label (e.g. Math tutor, Tuesdays)" maxLength={80} />
          <button
            className="btn small"
            disabled={!subjectKey || form.scopes.length === 0}
            onClick={() =>
              void api<CareGrant>('/api/care/grants', 'POST', { ...form, subject: subjectKey })
                .then(async (g) => {
                  setCreated(g);
                  await reload();
                })
                .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Could not create'))
            }
          >
            Create invite link
          </button>
          {created?.inviteLink && (
            <p className="small" data-testid="care-invite-link">
              Send this to them (works once, 7 days): <br />
              <code style={{ wordBreak: 'break-all' }}>{created.inviteLink}</code>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function ClientView({ c }: { c: ProClient }) {
  const [data, setData] = useState<ProScopeData | null>(null);
  const [notes, setNotes] = useState<CareGrantDetail['notes'] | null>(null);
  const [note, setNote] = useState('');
  return (
    <div className="card" data-testid="pro-client">
      <h2>
        {c.subject} <small className="muted">· {c.household}</small>
      </h2>
      <div className="chips">
        {c.scopes.map((s) => (
          <button key={s} className={data?.scope === s ? 'chip on' : 'chip'} onClick={() => void api<ProScopeData>(`/api/pro/clients/${c.grantId}/data/${s}`).then(setData)}>
            {CARE_SCOPE_LABEL[s]}
          </button>
        ))}
        <button className="chip" onClick={() => void api<{ notes: CareGrantDetail['notes'] }>(`/api/pro/clients/${c.grantId}/notes`).then((d) => setNotes(d.notes))}>
          Notes
        </button>
      </div>
      {data && (
        <ul className="plain small">
          {data.items.map((i, n) => (
            <li key={n}>
              {i.date && `${i.date} · `}
              <b>{i.title}</b> {i.detail}
            </li>
          ))}
          {data.items.length === 0 && <li className="muted">Nothing here yet.</li>}
        </ul>
      )}
      {notes && (
        <>
          {notes.map((n) => (
            <p key={n.id} className="small">
              <b>{n.author}</b> — {n.body}
            </p>
          ))}
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void api<{ notes: CareGrantDetail['notes'] }>(`/api/pro/clients/${c.grantId}/notes`, 'POST', { body: note }).then((d) => {
                setNotes(d.notes);
                setNote('');
              });
            }}
          >
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note…" aria-label="Note" />
            <button className="btn small">Add</button>
          </form>
        </>
      )}
    </div>
  );
}

/** Professional portal: profile, accept invites, the families who let you in. */
export function ProPortal() {
  const prof = useLoad<{ profile: ProProfile | null }>('/api/pro/me');
  const clients = useLoad<{ clients: ProClient[] }>('/api/pro/clients');
  const invite = new URLSearchParams(window.location.search).get('invite');
  const [p, setP] = useState<ProProfile>({ displayName: '', kind: 'tutor', credentials: '' });
  const [msg, setMsg] = useState<string | null>(null);
  if (!prof.data) return <p className="muted">Loading…</p>;
  const accept = (): void =>
    void api<{ clients: ProClient[] }>('/api/pro/accept', 'POST', { token: invite })
      .then((d) => {
        clients.setData(d);
        setMsg('You’re connected. Everything you open is logged for the family.');
        window.history.replaceState(null, '', '/pro');
      })
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Could not accept'));
  return (
    <section className="landing" data-testid="pro-portal">
      <h1>MyDay for professionals</h1>
      <p className="muted small">You see only what a family shares with you, only while they allow it. Every access is logged and visible to them.</p>
      {msg && <p role="status">{msg}</p>}
      {!prof.data.profile ? (
        <div className="card">
          <h2>Your profile</h2>
          <div className="form">
            <input value={p.displayName} onChange={(e) => setP({ ...p, displayName: e.target.value })} placeholder="Name families will see" maxLength={80} />
            <select value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value as CareKind })} aria-label="I am a">
              {CARE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CARE_KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <input value={p.credentials} onChange={(e) => setP({ ...p, credentials: e.target.value })} placeholder="Credentials (optional)" maxLength={200} />
            <button className="btn small" disabled={!p.displayName} onClick={() => void api<{ profile: ProProfile }>('/api/pro/profile', 'PUT', p).then((d) => prof.setData(d))}>
              Save profile
            </button>
          </div>
        </div>
      ) : (
        <p className="small">
          Signed in as <b>{prof.data.profile.displayName}</b> · {CARE_KIND_LABEL[prof.data.profile.kind]}
        </p>
      )}
      {invite && prof.data.profile && (
        <button className="btn" onClick={accept}>
          Accept this family’s invite
        </button>
      )}
      {(clients.data?.clients ?? []).map((c) => (
        <ClientView key={c.grantId} c={c} />
      ))}
      {prof.data.profile && clients.data?.clients.length === 0 && !invite && <p className="muted">No families yet — they’ll send you an invite link.</p>}
    </section>
  );
}
