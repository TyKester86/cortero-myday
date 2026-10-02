import { useState } from 'react';
import { KID_PIN_LENGTH, type KidAccessResponse, type SetKidPinRequest, type SetKidPinResponse } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';

/**
 * Grown-ups create, rotate or turn off each kid's PIN. A new PIN is shown
 * once — the server only keeps a hash — and signs the kid out everywhere.
 */
export default function KidAccess() {
  const { isAdult } = useSession();
  const { data, error, reload, setData } = useLoad<KidAccessResponse>(isAdult ? '/api/kid-access' : null);
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [shown, setShown] = useState<{ name: string; pin: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (!isAdult) return <p className="muted">Only grown-ups can manage kid sign-in.</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const setPin = async (memberId: number, name: string, pin?: string): Promise<void> => {
    const body: SetKidPinRequest = pin ? { pin } : {};
    try {
      const r = await api<SetKidPinResponse>(`/api/kid-access/${memberId}/pin`, 'PUT', body);
      setShown({ name, pin: r.pin });
      setCustom({ ...custom, [memberId]: '' });
      setMsg(null);
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const turnOff = async (memberId: number, name: string): Promise<void> => {
    if (!confirm(`Turn off PIN sign-in for ${name}? They'll be signed out.`)) return;
    setData(await api<KidAccessResponse>(`/api/kid-access/${memberId}/pin`, 'DELETE'));
  };

  return (
    <section className="card">
      <h2>Kid sign-in</h2>
      <p className="muted">
        Kids sign in with their first name and a {KID_PIN_LENGTH}-digit PIN — no Google account needed. Setting a new PIN signs them
        out on every device. Five wrong tries locks sign-in for 15 minutes.
      </p>

      {shown && (
        <div className="card current" data-testid="new-pin">
          <h2>{shown.name}'s new PIN</h2>
          <div className="pin">{shown.pin}</div>
          <p className="muted">Write it down for {shown.name} now — it won't be shown again.</p>
          <button className="link" onClick={() => setShown(null)}>
            Done
          </button>
        </div>
      )}
      {msg && <p className="error">{msg}</p>}

      {data.kids.length === 0 && <p className="muted">No kids on the roster yet.</p>}
      {data.kids.map((k) => (
        <div key={k.memberId} className="card">
          <div className="ex-head">
            <b>{k.name}</b>
            <small className={k.hasPin ? 'muted' : 'warn'}>
              {k.lockedUntil ? 'Locked (too many tries)' : k.hasPin ? 'PIN set' : 'No PIN yet'}
            </small>
          </div>
          <div className="inline">
            <button className="btn small" onClick={() => void setPin(k.memberId, k.name)}>
              {k.hasPin ? 'New random PIN' : 'Create random PIN'}
            </button>
            <input
              aria-label={`Choose a PIN for ${k.name}`}
              placeholder="or choose one"
              inputMode="numeric"
              value={custom[k.memberId] ?? ''}
              onChange={(e) => setCustom({ ...custom, [k.memberId]: e.target.value.replace(/\D/g, '').slice(0, KID_PIN_LENGTH) })}
            />
            <button
              className="btn small"
              disabled={(custom[k.memberId] ?? '').length !== KID_PIN_LENGTH}
              onClick={() => void setPin(k.memberId, k.name, custom[k.memberId])}
            >
              Set
            </button>
          </div>
          {k.hasPin && (
            <button className="link danger" onClick={() => void turnOff(k.memberId, k.name)}>
              Turn off PIN sign-in
            </button>
          )}
          {k.recentSignins.length > 0 && (
            <details data-testid={`signins-${k.key}`}>
              <summary className="muted small">Recent sign-ins</summary>
              <ul className="plain small">
                {k.recentSignins.slice(0, 8).map((s, i) => (
                  <li key={i} className={s.ok ? 'muted' : 'warn'}>
                    {new Date(s.at).toLocaleString()} · {s.device} · {s.ok ? 'signed in' : 'wrong PIN'}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
    </section>
  );
}
