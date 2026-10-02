import { useState, type FormEvent } from 'react';
import { KID_PIN_LENGTH, type DeviceKidsResponse, type KidPinLoginRequest } from '@myday/shared';
import { api, useLoad } from './api';

const LOGIN_ERRORS: Record<string, string> = {
  roster: "That Google account isn't on this household's roster yet. Ask a parent to add your email.",
  google: 'Google sign-in did not finish. Try again.',
  state: 'Sign-in expired. Try again.',
};

export default function Login() {
  const qs = new URLSearchParams(window.location.search);
  const err = qs.get('error');
  const [code, setCode] = useState(qs.get('code') ?? '');
  const device = useLoad<DeviceKidsResponse>('/api/auth/kid-device');
  const known = device.data?.kids ?? [];
  const [kid, setKid] = useState(qs.has('code'));
  const [name, setName] = useState('');
  const [picked, setPicked] = useState(false);
  const [pin, setPin] = useState('');
  const [remember, setRemember] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const kidLogin = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const body: KidPinLoginRequest & { household?: string } = { name, pin, remember, ...(code ? { household: code } : {}) };
    try {
      await api('/api/auth/kid-login', 'POST', body);
      window.location.href = '/';
    } catch (e2) {
      setPin('');
      setMsg(e2 instanceof Error ? e2.message : 'Could not sign in');
    }
  };

  const pick = (key: string): void => {
    setName(key);
    setPicked(true);
    setKid(true);
    setMsg(null);
  };

  const forget = async (key: string): Promise<void> => {
    await api('/api/auth/kid-device/forget', 'POST', { key });
    device.reload();
    setKid(false);
    setPicked(false);
    setName('');
  };

  return (
    <div className="login">
      <img src="/icons/myday-icon-192.png" alt="" width={96} height={96} />
      <h1>MyDay</h1>
      <p className="muted">One app for the whole family.</p>
      {err && <p className="error-light">{LOGIN_ERRORS[err] ?? 'Sign-in failed.'}</p>}

      {!kid && known.length > 0 && (
        <div className="kidpicker" data-testid="kid-picker">
          {known.map((k) => (
            <button key={k.key} className="kidbtn" onClick={() => pick(k.key)}>
              <span className="avatar">{k.name.slice(0, 1)}</span>
              {k.name}
            </button>
          ))}
        </div>
      )}

      {!kid ? (
        <>
          <a className="btn" href="/api/auth/google">
            Sign in with Google
          </a>
          <a className="link light" href="/api/auth/google" data-testid="start-trial">
            New here? Start a free 30-day trial
          </a>
          <button className="link light" onClick={() => setKid(true)}>
            I'm a kid — sign in with my PIN
          </button>
        </>
      ) : (
        <form className="kidlogin" onSubmit={(e) => void kidLogin(e)}>
          {picked ? (
            <p>
              Hi {known.find((k) => k.key === name)?.name ?? name}! Type your PIN.
            </p>
          ) : (
            <>
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))} placeholder="Family code (ask a grown-up)" autoCapitalize="characters" aria-label="Family code" />
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your first name" autoComplete="username" required />
            </>
          )}
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, KID_PIN_LENGTH))}
            placeholder={`${KID_PIN_LENGTH}-digit PIN`}
            inputMode="numeric"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
          />
          {!picked && (
            <label className="light small">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me on this device
            </label>
          )}
          <button className="btn" disabled={pin.length !== KID_PIN_LENGTH}>
            Sign in
          </button>
          {msg && <p className="error-light">{msg}</p>}
          {picked ? (
            <button type="button" className="link light" onClick={() => void forget(name)}>
              Not me — forget this name here
            </button>
          ) : null}
          <button
            type="button"
            className="link light"
            onClick={() => {
              setKid(false);
              setPicked(false);
              setPin('');
            }}
          >
            Back
          </button>
        </form>
      )}
      {!kid && (
        <div className="feature" style={{ maxWidth: 720, textAlign: 'left' }} data-testid="landing">
          {[
            ['✅ Today, for everyone', 'Chores, homework and tasks with points kids actually care about.'],
            ['💪 A year of training', 'Pick a body-style build; get 52 phased weeks, meals and protein math.'],
            ['🍽 Meals → groceries', '120 recipes with pictures. One tap builds the list and opens your store.'],
            ['📚 School, captured', 'Record a class; get real study notes, flashcards and homework found for you.'],
            ['💬 Hana', 'An AI that can actually do things — add tasks, groceries, move a workout.'],
            ['🏠 Any household', 'Families, couples, empty nesters, solo, and college students.'],
          ].map(([t, b]) => (
            <div key={t} className="card" style={{ color: 'var(--text)' }}>
              <b>{t}</b>
              <p className="small" style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
                {b}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
