import { useState, type FormEvent } from 'react';
import { KID_PIN_LENGTH, type DeviceKidsResponse, type KidPinLoginRequest } from '@myday/shared';
import { api, useLoad } from './api';

const LOGIN_ERRORS: Record<string, string> = {
  roster: "That account isn't on this household's roster yet. Ask a parent to add your email.",
  google: 'Google sign-in did not finish. Try again.',
  apple: 'Sign in with Apple did not finish. Try again.',
  state: 'Sign-in expired. Try again.',
  link: 'That sign-in link has expired or was already used. Send yourself a new one.',
};

interface Methods {
  google: boolean;
  email: boolean;
  apple: boolean;
}

/** Google, Apple, or a one-time email link — whichever the server has turned on. */
function SignInChoices({ primary = false }: { primary?: boolean }) {
  const { data } = useLoad<Methods>('/api/auth/methods');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const invite = new URLSearchParams(window.location.search).get('invite');
  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    try {
      await api('/api/auth/email', 'POST', { email, ...(invite ? { invite } : {}) });
      setSent(email);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not send the link');
    }
  };
  const m = data ?? { google: true, email: false, apple: false };
  return (
    <div className="signin-choices" data-testid="signin-choices">
      {m.google && (
        <a className="btn" href="/api/auth/google" data-testid={primary ? 'start-trial' : undefined}>
          {primary ? 'Start free with Google' : 'Continue with Google'}
        </a>
      )}
      {m.apple && (
        <a className="btn" href="/api/auth/apple" data-testid="apple-signin">
          Continue with Apple
        </a>
      )}
      {m.email &&
        (sent ? (
          <p className="lp-fine" role="status" data-testid="email-sent">
            Check {sent} — tap the link we sent to sign in (it works once, for 15 minutes).
          </p>
        ) : (
          <form className="email-signin" onSubmit={(e) => void send(e)}>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email address" autoComplete="email" />
            <button className="btn ghost light">Email me a sign-in link</button>
          </form>
        ))}
      {err && <p className="error-light">{err}</p>}
    </div>
  );
}

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

  const kidForm = (
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
  );

  // The kid PIN screen (and a device that remembers kids) stays a simple, focused card.
  if (kid || known.length > 0) {
    return (
      <div className="login">
        <img src="/icons/myday-icon-192.png" alt="" width={96} height={96} />
        <h1>MyDay</h1>
        {err && <p className="error-light">{LOGIN_ERRORS[err] ?? 'Sign-in failed.'}</p>}
        {!kid && (
          <>
            <div className="kidpicker" data-testid="kid-picker">
              {known.map((k) => (
                <button key={k.key} className="kidbtn" onClick={() => pick(k.key)}>
                  <span className="avatar">{k.name.slice(0, 1)}</span>
                  {k.name}
                </button>
              ))}
            </div>
            <a className="btn" href="/api/auth/google">
              Grown-up? Sign in with Google
            </a>
            <button className="link light" onClick={() => setKid(true)}>
              Someone else — sign in with a PIN
            </button>
          </>
        )}
        {kid && kidForm}
      </div>
    );
  }

  return <Landing err={err} onKid={() => setKid(true)} />;
}

const FEATURES: Array<[string, string, string]> = [
  ['✅', 'Chores and homework kids actually do', 'Points, quests and rewards they choose — and a grown-up approves. Nothing hangs over anyone.'],
  ['🌅', 'A calmer day for grown-ups', 'A morning check-in, your three most important tasks, and a two-minute evening close-out.'],
  ['🍽', 'Meals → groceries in one tap', '233 recipes with pictures from 25 cuisines. Plan the week and the shopping list builds itself.'],
  ['💪', 'A year of training that fits you', 'Nine evidence-based builds, 52 planned weeks, safe calorie and protein math — and teen-safe by default.'],
  ['🎙', 'Class notes that teach organizing', 'Record a lecture, even offline. Get structured notes, flashcards and the homework that was mentioned.'],
  ['💬', 'Hana, a helper that does things', 'Ask in plain words: add a task, a grocery, move a workout. She always asks before changing anything big.'],
];

const AUDIENCES = ['Families with kids', 'Couples', 'Just me', 'Empty nesters', 'Retired', 'College students'];

const FAQ: Array<[string, string]> = [
  ['Do I need to download an app?', 'No. MyDay runs in your phone’s browser — tap “Add to Home Screen” and it opens like any app, even without signal.'],
  ['Do my kids need their own phones?', 'No. Kids can use a family tablet or a parent’s phone with their own name and PIN. Older kids can use their own device.'],
  ['What does it cost?', 'Every household starts with a free 30-day trial, no card needed. You’ll see the price before the trial ends.'],
  ['Is our information private?', 'Your household’s data is walled off from every other household. Bank links are read-only — MyDay can never move money. Progress photos are encrypted and only their owner can see them.'],
  ['Is it for people with ADHD?', 'It was built with ADHD brains in mind: one thing at a time, gentle nudges, no guilt, and structure that teaches itself. It works just as well for everyone else.'],
];

/** The signed-out front door: what MyDay is, who it's for, and how to start. */
function Landing({ err, onKid }: { err: string | null; onKid: () => void }) {
  return (
    <div className="lp" data-testid="landing" id="top">
      <header className="lp-top">
        <span className="lp-brand">
          <img src="/icons/myday-mark.svg" alt="" width={28} height={28} />
          MyDay
        </span>
        <a className="lp-signin" href="/api/auth/google">
          Sign in
        </a>
      </header>

      <section className="lp-hero">
        <h1>The family day, handled.</h1>
        <p>
          Chores and homework kids actually do, a calmer plan for the grown-ups, meals that write the grocery list, and a helper that takes care of the busywork.
        </p>
        {err && <p className="error-light">{LOGIN_ERRORS[err] ?? 'Sign-in failed.'}</p>}
        <div className="lp-cta">
          <SignInChoices primary />
          <button className="btn ghost light" onClick={onKid}>
            I’m a kid — sign in with my PIN
          </button>
        </div>
        <p className="lp-fine">30 days free · no card needed · cancel anytime</p>
        <p className="lp-fine" data-testid="solo-note">
          Just you? MyDay works solo too — pick “Just me” after you sign in. Kid and partner tools stay out of your way until someone joins your household.
        </p>
      </section>

      <section className="lp-section">
        <h2>Who it’s for</h2>
        <div className="lp-chips">
          {AUDIENCES.map((a) => (
            <span key={a} className="lp-chip">
              {a}
            </span>
          ))}
        </div>
      </section>

      <section className="lp-section">
        <h2>What you get</h2>
        <div className="lp-features">
          {FEATURES.map(([icon, title, body]) => (
            <div key={title} className="lp-feature">
              <span className="lp-icon" aria-hidden="true">
                {icon}
              </span>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section lp-promise">
        <h2>Our promise</h2>
        <ul>
          <li>Built for brains that get overwhelmed: one thing at a time, gentle reminders, never guilt.</li>
          <li>Kids are protected by default: no calorie targets for teens, private spaces, grown-ups approve rewards.</li>
          <li>Your data is yours: walled off per household, bank access is read-only, photos are encrypted.</li>
        </ul>
      </section>

      <section className="lp-section">
        <h2>Questions</h2>
        {FAQ.map(([q, a]) => (
          <details key={q} className="lp-faq">
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </section>

      <section className="lp-hero lp-end">
        <h2>Try it with your family this week.</h2>
        <a className="btn" href="#top">
          Start free
        </a>
      </section>

      <footer className="lp-foot">
        <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <span>© {new Date().getFullYear()} MyDay</span>
      </footer>
    </div>
  );
}
