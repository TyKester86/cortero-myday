/**
 * JP4: location sharing — consent first. Everyone sees exactly who can see them. A grown-up sets
 * their own; the parents set a kid's. While your sharing is on, this device reports about where
 * you are when MyDay is open (never in the background). History is yours to see and delete.
 */
import { useEffect, useState } from 'react';
import type { LocationSeen, LocationSettings } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';

interface View {
  mine: LocationSettings;
  seen: LocationSeen[];
  kids: LocationSettings[];
}

/** While MyDay is open and your sharing is on: report this device's location every few minutes. */
export function useLocationReporting(on: boolean): void {
  useEffect(() => {
    if (!on || !navigator.geolocation) return;
    let stop = false;
    const send = (): void =>
      navigator.geolocation.getCurrentPosition(
        (p) => {
          if (!stop) void api('/api/location/ping', 'POST', { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }).catch(() => undefined);
        },
        () => undefined,
        { maximumAge: 120_000, timeout: 20_000 },
      );
    send();
    const t = window.setInterval(send, 5 * 60_000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [on]);
}

function Editor({ s, onSaved }: { s: LocationSettings; onSaved: () => void }) {
  const { members } = useSession();
  const [sharing, setSharing] = useState(s.sharing);
  const [viewers, setViewers] = useState<number[]>(s.viewers.map((v) => v.id));
  const [keep, setKeep] = useState(String(s.keepDays));
  const [err, setErr] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setErr(null);
    try {
      await api(`/api/location/settings/${s.memberId}`, 'PUT', { sharing, viewers, keepDays: Number(keep) });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t save');
    }
  };
  return (
    <div className="loc-editor" data-testid={`loc-editor-${s.memberId}`}>
      <label className="row">
        <input type="checkbox" checked={sharing} onChange={(e) => setSharing(e.target.checked)} aria-label={`Share ${s.member}’s location`} /> Share {s.member}’s location
      </label>
      {sharing && (
        <div className="row wrap small">
          With:
          {members
            .filter((m) => m.id !== s.memberId)
            .map((m) => (
              <label key={m.id}>
                <input type="checkbox" checked={viewers.includes(m.id)} onChange={(e) => setViewers(e.target.checked ? [...viewers, m.id] : viewers.filter((x) => x !== m.id))} /> {m.name}
              </label>
            ))}
        </div>
      )}
      <label className="small">
        Keep history{' '}
        <select value={keep} onChange={(e) => setKeep(e.target.value)} aria-label="Keep history for">
          {[1, 3, 7, 14, 30].map((d) => (
            <option key={d} value={d}>
              {d} day{d === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </label>{' '}
      <button className="btn small" onClick={() => void save()} data-testid="loc-save">
        Save
      </button>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

function History({ s, onDone }: { s: LocationSettings; onDone: () => void }) {
  const [sure, setSure] = useState(false);
  if (!s.historyPoints) return <p className="muted small">No location history kept.</p>;
  return (
    <p className="small">
      {s.historyPoints} point{s.historyPoints === 1 ? '' : 's'} kept (up to {s.keepDays} days){s.lastAt ? `, last ${new Date(s.lastAt).toLocaleString()}` : ''}.{' '}
      {sure ? (
        <>
          Delete all of it?{' '}
          <button className="btn small danger" onClick={() => void api(`/api/location/history/${s.memberId}`, 'DELETE').then(onDone)} data-testid="loc-forget-yes">
            Delete
          </button>{' '}
          <button className="link small" onClick={() => setSure(false)}>
            Keep
          </button>
        </>
      ) : (
        <button className="link danger small" onClick={() => setSure(true)} data-testid="loc-forget">
          Delete history
        </button>
      )}
    </p>
  );
}

export function LocationCard() {
  const { isAdult } = useSession();
  const { data, reload } = useLoad<View>('/api/location');
  if (!data) return null;
  const m = data.mine;
  return (
    <div className="card" data-testid="location-card">
      <h2>Location sharing</h2>
      <p className="small" data-testid="loc-who-sees-me">
        {m.sharing ? `${m.viewers.map((v) => v.name).join(' and ')} can see about where you are.` : 'Nobody can see where you are — sharing is off.'}
        {m.setBy && m.setBy !== m.member ? ` (Set by ${m.setBy}.)` : ''}
      </p>
      {isAdult ? <Editor key={`${m.sharing}${m.updatedAt}`} s={m} onSaved={reload} /> : <p className="muted small">Your grown-ups choose this for you. You can always check here who sees you.</p>}
      <History s={m} onDone={reload} />
      {data.seen.length > 0 && (
        <>
          <h3 className="ing-head">Shared with you</h3>
          <ul className="plain rows">
            {data.seen.map((x) => (
              <li key={x.memberId} data-testid="loc-seen">
                <b>{x.member}</b> <span className="muted small">· {x.where}{x.ago ? ` (${x.ago})` : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.kids.map((k) => (
        <div key={k.memberId} className="loc-kid">
          <h3 className="ing-head">{k.member}</h3>
          <p className="small">{k.sharing ? `${k.viewers.map((v) => v.name).join(' and ')} can see about where ${k.member} is.` : 'Off.'} {k.member} sees this too, and is told when it changes.</p>
          <Editor key={`${k.sharing}${k.updatedAt}`} s={k} onSaved={reload} />
          <History s={k} onDone={reload} />
        </div>
      ))}
    </div>
  );
}
