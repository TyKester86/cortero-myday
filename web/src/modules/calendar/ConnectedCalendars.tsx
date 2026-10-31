/**
 * C2: connect an outside calendar by its private iCal address (read-only). A grown-up connects
 * their own; a parent adds a child's school calendar. The address is never shown again.
 */
import { useState, type FormEvent } from 'react';
import type { CalendarSource, CalendarSourceKind } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { useSession } from '../../session';

const KINDS: Array<[CalendarSourceKind, string, string]> = [
  ['google', 'Google', 'Google Calendar → Settings → your calendar → “Secret address in iCal format”.'],
  ['outlook', 'Outlook', 'Outlook on the web → Settings → Calendar → Shared calendars → Publish a calendar → the ICS link.'],
  ['apple', 'Apple', 'iCloud Calendar → share the calendar as a Public Calendar → copy the webcal link.'],
  ['school', 'School', 'The school’s published calendar (an .ics or webcal link on its website).'],
  ['other', 'Other', 'Any calendar’s .ics or webcal link (a team, a club).'],
];

const ago = (iso: string | null): string => {
  if (!iso) return 'not read yet';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? 'read just now' : m < 60 ? `read ${m} min ago` : `read ${Math.round(m / 60)} h ago`;
};

export function ConnectedCalendars({ onChange }: { onChange: () => void }) {
  const { me, members, isAdult } = useSession();
  const { data, setData } = useLoad<{ sources: CalendarSource[] }>('/api/calendar/sources');
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<CalendarSourceKind>('google');
  const [member, setMember] = useState('');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const confirm = useConfirm();
  if (!data) return null;
  const kids = members.filter((m) => m.kind === 'kid');
  const forKid = member !== '';
  const mine = me.member?.id;

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ sources: CalendarSource[]; sync: { events: number; error: string | null } }>('/api/calendar/sources', 'POST', {
        url,
        kind: forKid && kind !== 'other' ? 'school' : kind,
        label: label || undefined,
        member: member || undefined,
        visibility: details ? 'details' : 'busy',
      });
      setData({ sources: r.sources });
      setMsg(r.sync.error ? `Saved, but it couldn’t be read yet: ${r.sync.error}` : `Connected — ${r.sync.events} thing${r.sync.events === 1 ? '' : 's'} read.`);
      setAdding(false);
      setUrl('');
      setLabel('');
      onChange();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Couldn’t connect that');
    } finally {
      setBusy(false);
    }
  };
  const act = async (s: CalendarSource, what: 'sync' | 'remove' | 'details' | 'busy'): Promise<void> => {
    if (what === 'remove' && !(await confirm({ title: `Disconnect ${s.member}’s ${s.label}?`, body: 'Its events leave the family timeline. Nothing changes in the calendar itself.', confirmLabel: 'Disconnect', danger: true }))) return;
    try {
      const r =
        what === 'sync'
          ? await api<{ sources: CalendarSource[] }>(`/api/calendar/sources/${s.id}/sync`, 'POST')
          : what === 'remove'
            ? await api<{ sources: CalendarSource[] }>(`/api/calendar/sources/${s.id}`, 'DELETE')
            : await api<{ sources: CalendarSource[] }>(`/api/calendar/sources/${s.id}`, 'PATCH', { visibility: what });
      setData({ sources: r.sources });
      onChange();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'That didn’t go through');
    }
  };

  if (!isAdult && !data.sources.length) return null;
  return (
    <div className="card" data-testid="cal-sources">
      <h2>Connected calendars</h2>
      <p className="muted small">Read-only: MyDay reads them every 30 minutes to find conflicts and never changes them. {isAdult ? 'Your own shows the family only “Busy” unless you choose details.' : ''}</p>
      {data.sources.length > 0 && (
        <ul className="cal-sources">
          {data.sources.map((s) => (
            <li key={s.id} data-testid="cal-source">
              <span>
                <b>
                  {s.member}’s {s.label}
                </b>{' '}
                <small className="muted">
                  {s.hint} · {ago(s.lastSyncedAt)} · {s.events} thing{s.events === 1 ? '' : 's'} · {s.visibility === 'busy' ? 'busy-only to others' : 'details shown'}
                </small>
              </span>
              {s.error && <small className="error">{s.error}</small>}
              {isAdult && (s.memberKey === me.member?.key || kids.some((k) => k.key === s.memberKey)) && (
                <span className="row">
                  <button type="button" className="btn small ghost" onClick={() => void act(s, 'sync')}>
                    Read now
                  </button>
                  {s.memberKey === me.member?.key && (
                    <button type="button" className="btn small ghost" onClick={() => void act(s, s.visibility === 'busy' ? 'details' : 'busy')} data-testid="cal-source-visibility">
                      {s.visibility === 'busy' ? 'Show details' : 'Busy-only'}
                    </button>
                  )}
                  <button type="button" className="btn small ghost" onClick={() => void act(s, 'remove')}>
                    Disconnect
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="small muted" role="status">{msg}</p>}
      {isAdult && mine !== undefined && !adding && (
        <button type="button" className="btn small" onClick={() => setAdding(true)} data-testid="cal-source-add">
          + Connect a calendar
        </button>
      )}
      {adding && (
        <form className="cal-source-form" onSubmit={(e) => void add(e)}>
          <label>
            Whose{' '}
            <select value={member} onChange={(e) => setMember(e.target.value)} data-testid="cal-source-member">
              <option value="">Mine</option>
              {kids.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.name} (school or activity)
                </option>
              ))}
            </select>
          </label>
          <div className="chips" role="group" aria-label="Which calendar">
            {KINDS.filter(([k]) => (forKid ? k === 'school' || k === 'other' : k !== 'school')).map(([k, name]) => (
              <button type="button" key={k} className={kind === k ? 'chip on' : 'chip'} onClick={() => setKind(k)}>
                {name}
              </button>
            ))}
          </div>
          <small className="muted">{KINDS.find(([k]) => k === (forKid && kind !== 'other' ? 'school' : kind))?.[2]}</small>
          <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Private iCal (.ics) or webcal:// link" aria-label="Calendar link" data-testid="cal-source-url" />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional), e.g. Work" maxLength={40} aria-label="Calendar name" />
          {!forKid && (
            <label className="small">
              <input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} /> Show the family titles and places (otherwise just “Busy”)
            </label>
          )}
          <span className="row">
            <button type="button" className="btn small ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn small" disabled={busy || !url.trim()} data-testid="cal-source-save">
              {busy ? 'Reading…' : 'Connect'}
            </button>
          </span>
        </form>
      )}
    </div>
  );
}
