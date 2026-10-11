/**
 * Provider Knowledge Base: the provider sign-up (its own path), your provider status, and the badge.
 * Verification runs first — the NPI Registry and the OIG exclusion list — and no account exists until it passes.
 * Providers here are community members with a badge: nothing is bookable, there's no clinical relationship.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, useLoad } from '../../api';
import { SignInChoices } from '../../Login';
import { FEED_APP } from '../../apps';
import { Horn, Icon, TopBar } from './kit';
import { Gate } from '../community/Community';

const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' ');

interface Meta {
  taxonomies: Array<{ code: string; label: string }>;
  rules: string[];
  disclaimer: string;
}

/** The badge: its own lane (an outline shield), distinct from anything a future clinical tier would show. */
export function ProviderBadge({ compact = false, testid }: { compact?: boolean; testid?: string }) {
  return (
    <span className={compact ? 'sc-provider-badge compact' : 'sc-provider-badge'} data-testid={testid ?? (compact ? 'provider-badge-mini' : 'provider-badge')} title="Verified provider background">
      <Icon name="shield" size={compact ? 13 : 15} />
      Verified provider background
    </span>
  );
}

export function ProviderDisclaimer({ text }: { text: string }) {
  return (
    <p className="sc-provider-disclaimer" data-testid="provider-disclaimer">
      <Icon name="info" size={16} /> {text}
    </p>
  );
}

/** /providers — signed out (verify first, then sign in) or signed in (verify your background). */
export function ProviderSignupPage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    void api('/api/me').then(
      () => setSignedIn(true),
      () => setSignedIn(false),
    );
  }, []);
  return (
    <div className="app social-only sc-app" data-testid="provider-signup-page">
      <main className="sc-main">
        <header className="sc-bar home">
          <Horn size={36} />
          <h1 className="sc-wordmark" style={{ fontSize: 24 }}>
            The Feed · for providers
          </h1>
        </header>
        {signedIn !== null && <ProviderForm signedIn={signedIn} />}
      </main>
    </div>
  );
}

type Result = { status: 'verified' | 'needs_review' | 'rejected'; reason?: string; message?: string; pass?: string };

function ProviderForm({ signedIn }: { signedIn: boolean }) {
  const { data: meta } = useLoad<Meta>('/api/providers/taxonomies');
  const [f, setF] = useState({ legalName: '', displayName: '', npi: '', taxonomy: '', credentials: '', bio: '', licenseStates: [] as string[], agree: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  if (!meta) return <p className="sc-meta">Loading…</p>;
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch('/api/providers/check', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
      const body = (await r.json().catch(() => ({}))) as Result & { error?: string };
      if (r.status === 422 && body.status === 'rejected') setResult(body);
      else if (!r.ok) setErr(body.error ?? 'Something went wrong — try again.');
      else setResult(body);
    } catch {
      setErr('Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  };
  if (result) {
    if (result.status === 'rejected')
      return (
        <section className="sc-card sc-note" data-testid="provider-result" data-status="rejected">
          <h2 className="sc-h2">We couldn’t verify that</h2>
          <p data-testid="provider-reason">{result.reason}</p>
          <p className="sc-meta">No account was created. If something’s off on your NPI record, update it with NPPES first.</p>
          <button type="button" className="sc-btn outline small" onClick={() => setResult(null)}>
            Try again
          </button>
        </section>
      );
    return (
      <section className="sc-card sc-note" data-testid="provider-result" data-status={result.status}>
        <h2 className="sc-h2">{result.status === 'verified' ? 'Verified' : 'We’re reviewing your credentials'}</h2>
        <p>{result.message}</p>
        {result.pass && !signedIn ? (
          <>
            <p className="sc-meta">Now sign in to create your Feed account — your provider background comes with it.</p>
            <SignInChoices age={result.pass} />
          </>
        ) : (
          <Link className="sc-btn small" to="/feed" reloadDocument>
            Go to the Feed
          </Link>
        )}
      </section>
    );
  }
  const toggleState = (s: string): void => setF({ ...f, licenseStates: f.licenseStates.includes(s) ? f.licenseStates.filter((x) => x !== s) : [...f.licenseStates, s] });
  return (
    <form className="sc-provider-form" onSubmit={(e) => void submit(e)} data-testid="provider-form">
      <section className="sc-card sc-note">
        <h2 className="sc-h2">Share what you know</h2>
        <p>
          Licensed mental-health professionals can join The Feed with a <b>Verified provider background</b> badge and contribute knowledge — posts, answers, polls — as credentialed members of the community.
        </p>
        <p className="sc-meta">
          This isn’t a therapy listing: you won’t be bookable, and nothing here sets up a clinical relationship. We check your NPI against the public NPI Registry and the OIG exclusion list — free and automatic. We keep your NPI and the
          results, never your SSN or date of birth.
        </p>
      </section>
      <div className="sc-card sc-form">
        <label>
          <span>Legal name</span>
          <input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} required maxLength={120} placeholder="As on your NPI record" data-testid="provider-legal-name" autoComplete="name" />
        </label>
        <label>
          <span>First name</span>
          <input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required maxLength={24} placeholder="What people see" data-testid="provider-display-name" />
        </label>
        <label>
          <span>NPI</span>
          <input value={f.npi} onChange={(e) => setF({ ...f, npi: e.target.value.replace(/\D/g, '').slice(0, 10) })} required inputMode="numeric" placeholder="10 digits" data-testid="provider-npi" />
        </label>
        <label>
          <span>Specialty</span>
          <select value={f.taxonomy} onChange={(e) => setF({ ...f, taxonomy: e.target.value })} required data-testid="provider-taxonomy">
            <option value="">Choose…</option>
            {meta.taxonomies.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Credentials</span>
          <input value={f.credentials} onChange={(e) => setF({ ...f, credentials: e.target.value })} maxLength={60} placeholder="e.g. LCSW, ADHD-CCSP" data-testid="provider-credentials-input" />
        </label>
        <label>
          <span>Bio</span>
          <textarea value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={280} rows={2} placeholder="About you and your work" data-testid="provider-bio" />
        </label>
      </div>
      <div className="sc-card sc-note">
        <b>License state(s)</b> <small className="sc-meta">self-reported</small>
        <div className="sc-chips" style={{ marginTop: 8 }}>
          {STATES.map((s) => (
            <button key={s} type="button" className={f.licenseStates.includes(s) ? 'sc-filter on' : 'sc-filter'} onClick={() => toggleState(s)} aria-pressed={f.licenseStates.includes(s)} data-testid={`provider-state-${s}`}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <section className="sc-card sc-note" data-testid="provider-rules">
        <b>The provider rules</b>
        <ul>
          {meta.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <label className="sc-check-row">
          <input type="checkbox" checked={f.agree} onChange={(e) => setF({ ...f, agree: e.target.checked })} data-testid="provider-agree" /> I’ll follow these rules
        </label>
      </section>
      {err && (
        <p className="error" role="alert" data-testid="provider-error">
          {err}
        </p>
      )}
      <button className="sc-btn" disabled={busy || !f.agree} data-testid="provider-submit">
        {busy ? 'Checking the NPI Registry…' : 'Verify my background'}
      </button>
      <p className="sc-meta sc-center">
        <a href={FEED_APP ? '/' : '/feed'}>Back to the Feed</a>
      </p>
    </form>
  );
}

interface Mine {
  provider: null | { status: string; reason: string | null; badge: string; specialty: string; credentials: string | null; licenseStates: string[]; npiLast4: string; strikes: number; verifiedAt: string | null };
  rules: string[];
  disclaimer: string;
}

/** Settings → Provider background. */
export function ProviderStatusPage() {
  return (
    <section className="sc-page feed-page" data-testid="provider-status-page">
      <TopBar title="Provider background" />
      <Gate>{() => <ProviderStatus />}</Gate>
    </section>
  );
}

function ProviderStatus() {
  const { data } = useLoad<Mine>('/api/providers/me');
  if (!data) return <p className="sc-meta">Loading…</p>;
  const p = data.provider;
  if (!p)
    return (
      <section className="sc-card sc-note">
        <p>Are you a licensed mental-health professional? Verify your background (free) to post and answer with a “Verified provider background” badge.</p>
        <a className="sc-btn small" href="/providers" data-testid="provider-start">
          Verify my background
        </a>
      </section>
    );
  const label: Record<string, string> = { active: 'Your badge is live', suspended: 'Your badge is paused', revoked: 'Your badge was removed', none: p.status === 'needs_review' ? 'We’re reviewing your credentials' : 'Not verified' };
  return (
    <>
      <section className="sc-card sc-note" data-testid="provider-status" data-badge={p.badge} data-status={p.status}>
        <h2 className="sc-h2">{label[p.badge] ?? p.status}</h2>
        {p.badge === 'active' && <ProviderBadge />}
        {p.reason && <p className="sc-meta">{p.reason}</p>}
        <ul className="sc-details" style={{ marginTop: 10 }}>
          <li>
            <span>Specialty</span> <b>{p.specialty}</b>
          </li>
          {p.credentials && (
            <li>
              <span>Credentials</span> <b>{p.credentials}</b>
            </li>
          )}
          <li>
            <span>NPI</span> <b>…{p.npiLast4}</b>
          </li>
          {p.licenseStates.length > 0 && (
            <li>
              <span>States</span> <b>{p.licenseStates.join(', ')} (self-reported)</b>
            </li>
          )}
        </ul>
        {p.strikes > 0 && <p className="sc-meta">Solicitation warnings: {p.strikes} of 2.</p>}
      </section>
      <ProviderDisclaimer text={data.disclaimer} />
      <section className="sc-card sc-note">
        <b>The provider rules</b>
        <ul>
          {data.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
