import { useState } from 'react';
import { Link } from 'react-router';
import {
  BUILD_INFO,
  BUILDS,
  HOUSEHOLD_TYPE_ICON,
  HOUSEHOLD_TYPE_INFO,
  HOUSEHOLD_TYPES,
  KID_PIN_LENGTH,
  featuresFor,
  weakPinReason,
  type BuildKey,
  type CreateHouseholdRequest,
  type HouseholdAdminResponse,
  type HouseholdInfo,
  type HouseholdType,
  type InviteCreated,
  type OnboardingStep,
} from '@myday/shared';
import { api, ApiFail } from './api';
import { JoinBox } from './components/JoinFlow';
import QR from './components/QR';
import { useSession } from './session';
import RoleArt from './components/RoleArt';

/** Step 1 (signed in, no household yet): pick the household type and create it — the 30-day trial starts. */
export function CreateHousehold() {
  const { me } = useSession();
  const [type, setType] = useState<HouseholdType>('family');
  const [householdName, setHh] = useState('');
  const [yourName, setName] = useState(me.name.split(' ')[0] ?? '');
  const [school, setSchool] = useState('');
  const [build, setBuild] = useState<BuildKey | ''>('');
  const [err, setErr] = useState<string | null>(null);
  const missing = [!householdName.trim() && 'a household name', !yourName.trim() && 'your first name'].filter(Boolean) as string[];
  // Back = sign out and return to the start (e.g. signed in with the wrong account).
  const back = async (): Promise<void> => {
    await api('/api/auth/logout', 'POST').catch(() => undefined);
    window.location.href = '/';
  };
  const create = async (): Promise<void> => {
    try {
      const body: CreateHouseholdRequest = { householdName, type, yourName, school: school || null, build: build || null };
      await api('/api/households', 'POST', body);
      window.location.href = '/setup';
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create it');
    }
  };
  return (
    <div className="landing" data-testid="create-household">
      <p className="create-back">
        <button type="button" className="btn small ghost" onClick={() => void back()} data-testid="create-back">
          ← Back
        </button>{' '}
        <span className="small muted">Signed in as {me.email}</span>
      </p>
      <div className="steps-bar">
        <i className="on" />
        <i />
        <i />
        <i />
        <i />
      </div>
      <h1>Set up your household</h1>
      <p className="small">
        Just here for the community?{' '}
        <a href="/feed" data-testid="feed-only">
          Go straight to the Feed →
        </a>{' '}
        <span className="muted">(free, 18+ — you can set up MyDay any time)</span>
      </p>
      <JoinBox />
      <h2>Or start a new household</h2>
      <p className="muted">Your free 30-day trial starts now. No card needed.</p>
      <p className="small">
        Tutor, coach or provider invited by a family? <a href="/pro">Go to the professional portal →</a>
      </p>
      <h2>Who's it for?</h2>
      <div className="buildgrid">
        {HOUSEHOLD_TYPES.map((t) => (
          <button key={t} type="button" className={type === t ? 'buildopt on' : 'buildopt'} onClick={() => setType(t)} aria-pressed={type === t}>
            <RoleArt src={HOUSEHOLD_TYPE_ICON[t]} />
            <b>{HOUSEHOLD_TYPE_INFO[t].label}</b>
            <small>{HOUSEHOLD_TYPE_INFO[t].blurb}</small>
          </button>
        ))}
      </div>
      <div className="form" style={{ marginTop: 12 }}>
        <label>
          Household name
          <input value={householdName} onChange={(e) => setHh(e.target.value)} placeholder="e.g. The Kesters" maxLength={60} />
        </label>
        <label>
          Your first name
          <input value={yourName} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </label>
        {type === 'college' && (
          <label>
            Your school (optional)
            <input value={school} onChange={(e) => setSchool(e.target.value)} maxLength={120} placeholder="Start typing your school" />
          </label>
        )}
        <label>
          A body-style goal for you (optional — you can do this later)
          <select value={build} onChange={(e) => setBuild(e.target.value as BuildKey | '')}>
            <option value="">Later</option>
            {BUILDS.map((b) => (
              <option key={b} value={b}>
                {BUILD_INFO[b].label} ({BUILD_INFO[b].group})
              </option>
            ))}
          </select>
        </label>
        <button className="btn" disabled={missing.length > 0} onClick={() => void create()} data-testid="start-trial">
          Start my free trial
        </button>
        {missing.length > 0 && (
          <p className="small muted create-missing" data-testid="start-trial-missing">
            To start, fill in {missing.join(' and ')} above.
          </p>
        )}
        {err && <p className="error">{err}</p>}
      </div>
    </div>
  );
}

/** Steps 2–5: invite a partner (link + QR), add kids (PIN + family code + QR), connect Classroom, link a bank. Every step can be skipped. */
export default function Setup() {
  const { me } = useSession();
  const [hh, setHh] = useState<HouseholdInfo | null>(me.household);
  const [invite, setInvite] = useState<InviteCreated | null>(null);
  const [partner, setPartner] = useState({ name: '', email: '' });
  const [kid, setKid] = useState({ name: '', age: '', school: '', pin: '', pinMode: 'choose' as 'choose' | 'generate' });
  const [kidsAdded, setKidsAdded] = useState<Array<{ name: string; pin: string }>>([]);
  const [schools, setSchools] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  if (!hh) return null;
  const f = featuresFor(hh.type);
  const steps: OnboardingStep[] = [...(f.partner ? (['invite'] as const) : []), ...(f.kids ? (['kids'] as const) : []), ...(f.student ? (['classroom'] as const) : []), 'bank'];
  const current = steps.find((s) => !hh.onboarding[s]);
  const mark = async (step: OnboardingStep, skipped = false): Promise<void> => {
    setErr(null);
    setHh(await api<HouseholdInfo>(`/api/onboarding/${step}`, 'POST', { skipped }));
  };
  const loginUrl = `${window.location.origin}/?code=${hh.code}`;
  const wrap = (p: Promise<unknown>): void => void p.catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Something went wrong'));

  return (
    <div className="landing" data-testid="setup">
      <h1 className="sr-only">Finish setting up</h1>
      <div className="steps-bar">
        <i className="on" />
        {steps.map((s) => (
          <i key={s} className={hh.onboarding[s] || s === current ? 'on' : ''} />
        ))}
      </div>
      {err && <p className="error">{err}</p>}

      {current === 'invite' && (
        <div className="card" data-testid="setup-invite">
          <h2>Invite your partner</h2>
          {invite ? (
            <>
              <p>Send this link, or have them scan it. It works once and expires in 7 days.</p>
              <QR value={invite.link} label="Invite QR code" />
              <p className="small" style={{ wordBreak: 'break-all' }}>
                {invite.link}
              </p>
              <button className="btn small ghost" onClick={() => wrap(navigator.clipboard.writeText(invite.link))}>
                Copy link
              </button>{' '}
              <button className="btn small" onClick={() => wrap(mark('invite'))}>
                Next
              </button>
            </>
          ) : (
            <div className="form">
              <input value={partner.name} onChange={(e) => setPartner({ ...partner, name: e.target.value })} placeholder="Their first name" />
              <input value={partner.email} onChange={(e) => setPartner({ ...partner, email: e.target.value })} placeholder="Their Google email" type="email" />
              <button
                className="btn small"
                disabled={!partner.name || !partner.email}
                onClick={() => wrap(api<InviteCreated>('/api/household/invites', 'POST', { name: partner.name, email: partner.email, xpTrack: me.xpTrack === 'woman' ? 'leader' : 'woman' }).then(setInvite))}
              >
                Create invite
              </button>
            </div>
          )}
          {!invite && (
            <button className="link" onClick={() => wrap(mark('invite', true))}>
              Skip for now
            </button>
          )}
        </div>
      )}

      {current === 'kids' && (
        <div className="card" data-testid="setup-kids">
          <h2>Add your kids</h2>
          <p className="muted small">Kids sign in with their first name and a 6-digit PIN — no email or Google account.</p>
          <div className="form">
            <input value={kid.name} onChange={(e) => setKid({ ...kid, name: e.target.value })} placeholder="Kid's first name" />
            <input value={kid.age} onChange={(e) => setKid({ ...kid, age: e.target.value.replace(/\D/g, '').slice(0, 2) })} placeholder="Age" inputMode="numeric" />
            <input
              value={kid.school}
              list="school-list"
              onFocus={() => wrap(api<{ schools: string[] }>('/api/schools').then((r) => setSchools(r.schools)))}
              onChange={(e) => setKid({ ...kid, school: e.target.value })}
              placeholder="School (optional)"
            />
            <datalist id="school-list">
              {schools.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <fieldset className="pin-choice" data-testid="kid-pin-choice">
              <legend className="small">Their sign-in PIN</legend>
              <label className="inline-label">
                <input type="radio" name="pin-mode" checked={kid.pinMode === 'choose'} onChange={() => setKid({ ...kid, pinMode: 'choose' })} /> I’ll choose a {KID_PIN_LENGTH}-digit PIN
              </label>
              {kid.pinMode === 'choose' && (
                <input
                  value={kid.pin}
                  onChange={(e) => setKid({ ...kid, pin: e.target.value.replace(/\D/g, '').slice(0, KID_PIN_LENGTH) })}
                  placeholder={`${KID_PIN_LENGTH}-digit PIN`}
                  aria-label="Kid's PIN"
                  inputMode="numeric"
                  autoComplete="off"
                />
              )}
              <label className="inline-label">
                <input type="radio" name="pin-mode" checked={kid.pinMode === 'generate'} onChange={() => setKid({ ...kid, pinMode: 'generate' })} /> Make one for me
              </label>
            </fieldset>
            <button
              className="btn small"
              disabled={!kid.name.trim() || (kid.pinMode === 'choose' && kid.pin.length !== KID_PIN_LENGTH)}
              onClick={() =>
                wrap(
                  (async () => {
                    setErr(null);
                    const name = kid.name.trim();
                    // Check the chosen PIN first, so a weak one never leaves a kid on the roster without a PIN.
                    const weak = kid.pinMode === 'choose' ? weakPinReason(kid.pin) : null;
                    if (weak) throw new Error(weak);
                    let roster: HouseholdAdminResponse;
                    let note = '';
                    try {
                      roster = await api<HouseholdAdminResponse>('/api/household/members', 'POST', { name, kind: 'kid', age: kid.age || null, xpTrack: 'kid' });
                    } catch (e) {
                      // Already on the roster (e.g. added earlier): pair that kid instead of adding a second one.
                      if (!(e instanceof ApiFail) || e.code !== 'duplicate_kid') throw e;
                      roster = await api<HouseholdAdminResponse>('/api/household/admin');
                      note = ' (already on your roster)';
                    }
                    const added = [...roster.members].reverse().find((m) => m.kind === 'kid' && !m.archived && m.name.toLowerCase() === name.toLowerCase());
                    if (!added) throw new Error('Kid not found after adding');
                    if (kid.school) await api(`/api/household/members/${added.id}`, 'PATCH', { school: kid.school }).catch(() => undefined);
                    const pin = await api<{ pin: string }>(`/api/kid-access/${added.id}/pin`, 'PUT', kid.pinMode === 'choose' ? { pin: kid.pin } : {});
                    setKidsAdded([...kidsAdded.filter((k) => k.name !== added.name), { name: added.name + note, pin: pin.pin }]);
                    setKid({ name: '', age: '', school: '', pin: '', pinMode: kid.pinMode });
                  })(),
                )
              }
            >
              Add kid
            </button>
          </div>
          {kidsAdded.length > 0 && (
            <>
              <h2>Pair their phones</h2>
              <p className="small">
                On the kid's phone, scan this (or open MyDay and type family code <b>{hh.code}</b>), then their name and PIN:
              </p>
              <QR value={loginUrl} label="Kid sign-in QR code" />
              <ul className="plain">
                {kidsAdded.map((k) => (
                  <li key={k.name}>
                    {k.name}: PIN <b>{k.pin}</b> <small className="muted">(write it down — it's shown once)</small>
                  </li>
                ))}
              </ul>
              <button className="btn small" onClick={() => wrap(mark('kids'))}>
                Next
              </button>
            </>
          )}
          {kidsAdded.length === 0 && (
            <button className="link" onClick={() => wrap(mark('kids', true))}>
              Skip for now
            </button>
          )}
        </div>
      )}

      {current === 'classroom' && (
        <div className="card" data-testid="setup-classroom">
          <h2>Connect Google Classroom</h2>
          <p className="small">Bring in class names automatically (read-only). Or add classes by hand later on the School page.</p>
          <button className="btn small" onClick={() => wrap(mark('classroom').then(() => (window.location.href = '/school')))}>
            Connect on the School page
          </button>{' '}
          <button className="link" onClick={() => wrap(mark('classroom', true))}>
            Skip for now
          </button>
        </div>
      )}

      {current === 'bank' && (
        <div className="card" data-testid="setup-bank">
          <h2>Link your bank (optional)</h2>
          <p className="small">Read-only through Plaid: balances, safe-to-spend, subscriptions. MyDay can never move money. You can also track bills by hand.</p>
          <button className="btn small" onClick={() => wrap(mark('bank').then(() => (window.location.href = '/money')))}>
            Link on the Money page
          </button>{' '}
          <button className="link" onClick={() => wrap(mark('bank', true))}>
            Skip for now
          </button>
        </div>
      )}

      {!current && (
        <div className="card" data-testid="setup-done">
          <h2>You're set 🎉</h2>
          <p>Everything else can be changed any time in Settings and Household.</p>
          <Link className="btn" to="/">
            Go to today
          </Link>
        </div>
      )}
    </div>
  );
}
