/**
 * The Provider Business Suite (verified licensed providers): analytics for your own content, ads
 * (boost a post or clip, or run a campaign), and consult slots people can book. Lives under the Feed.
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { AdCampaign, BoostPackage, BusinessAnalytics, BusinessOverview, ClipItem, ConsultSlot, FeedPage } from '@myday/shared';
import { api, ApiFail, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { count } from '../../format';
import { FeedNav, FeedTitle } from './shell';

const money = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const num = (n: number): string => n.toLocaleString('en-US');
const errText = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);
/** Checkout lives on Stripe's site; the stub (local/tests) comes straight back. */
const go = (url: string): void => {
  if (url.startsWith('/')) window.location.assign(url);
  else window.location.href = url;
};

type Tab = 'analytics' | 'ads' | 'consults';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'analytics', label: 'Analytics' },
  { key: 'ads', label: 'Ads' },
  { key: 'consults', label: 'Consults' },
];

export function BusinessPage() {
  const { data, error, setData, reload } = useLoad<BusinessOverview>('/api/business');
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'analytics');
  const [note, setNote] = useState<string | null>(null);
  // Back from Checkout: confirm with Stripe (the webhook may not have landed yet), then refresh.
  useEffect(() => {
    const paid = params.get('paid');
    const sid = params.get('session_id');
    if (params.get('canceled')) setNote('Checkout canceled — nothing was charged.');
    if (!paid) return;
    setTab('ads');
    const done = (): void => {
      setNote('Paid — your ad is live. It shows as “Sponsored” in the Feed until its impressions run out.');
      setParams({}, { replace: true });
      reload();
    };
    if (sid) void api('/api/business/checkout/confirm?session_id=' + encodeURIComponent(sid)).then(done, done);
    else done();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const notProvider = error && /Verified provider background/.test(error);
  return (
    <section className="feed-page business" data-testid="business">
      <FeedTitle>Business</FeedTitle>
      <FeedNav />
      {notProvider ? (
        <div className="card" data-testid="business-locked">
          <h2>For verified providers</h2>
          <p>The Business Suite — boosts, ads to your profile, and analytics — opens once your provider background is verified (free: your NPI, checked against the NPI Registry and the OIG exclusion list).</p>
          <p className="small muted">
            <a href="/providers">Verify my provider background →</a>
          </p>
        </div>
      ) : error ? (
        <p className="error">{error}</p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <nav className="desk-tabs" aria-label="Business">
            {TABS.filter((t) => t.key !== 'consults' || data.bookable).map((t) => (
              <button key={t.key} className={tab === t.key ? 'desk-tab on' : 'desk-tab'} aria-pressed={tab === t.key} onClick={() => setTab(t.key)} data-testid={`biz-tab-${t.key}`}>
                {t.label}
              </button>
            ))}
          </nav>
          {note && (
            <p className="desk-note" role="status" data-testid="biz-note">
              {note}
            </p>
          )}
          {data.payments === 'none' && <p className="card note small">Payments aren’t switched on for this server yet — you can draft, but ads can’t go live.</p>}
          {tab === 'analytics' && <Analytics bookable={!!data.bookable} />}
          {tab === 'ads' && <Ads o={data} onChange={(campaigns) => setData({ ...data, campaigns })} onNote={setNote} />}
          {tab === 'consults' && data.bookable && <Consults slots={data.slots} onChange={(slots) => setData({ ...data, slots })} />}
        </>
      )}
    </section>
  );
}

/* ---------- analytics ---------- */

function Spark({ points, label }: { points: number[]; label: string }) {
  const w = 300;
  const h = 64;
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const d = points.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - 4 - (v / max) * (h - 8)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="biz-spark" role="img" aria-label={label} preserveAspectRatio="none">
      <path d={`${d} L${w},${h} L0,${h} Z`} className="biz-spark-fill" />
      <path d={d} className="biz-spark-line" />
    </svg>
  );
}

function Analytics({ bookable }: { bookable: boolean }) {
  const [range, setRange] = useState(30);
  const { data, error } = useLoad<BusinessAnalytics>(`/api/business/analytics?range=${range}`);
  const t = data?.totals;
  const tiles: Array<[string, string, string]> = t
    ? [
        ['profile-views', 'Profile views', num(t.profileViews)],
        ['followers', 'Followers', `${num(t.followers)}${t.newFollowers ? ` (+${num(t.newFollowers)})` : ''}`],
        ['post-views', 'Post views', num(t.postViews)],
        ['clip-views', 'Clip views', num(t.clipViews)],
        ['story-views', 'Story views', num(t.storyViews)],
        ['engagement', 'Engagement', `${num(t.engagement)} · ${t.engagementRate}%`],
        ...(bookable
          ? ([
              ['bookings', 'Consult bookings', num(t.consultBookings)],
              ['revenue', 'Revenue', money(t.revenueCents)],
            ] as Array<[string, string, string]>)
          : []),
        ['ad-impressions', 'Ad impressions', num(t.adImpressions)],
        ['ad-clicks', 'Ad clicks', num(t.adClicks)],
      ]
    : [];
  return (
    <div className="biz-analytics" data-testid="biz-analytics">
      <div className="row biz-range">
        <span className="feed-nav biz-ranges" role="group" aria-label="Range">
          {[7, 30, 90].map((r) => (
            <button key={r} type="button" className={r === range ? 'feed-nav-link active' : 'feed-nav-link'} aria-pressed={r === range} onClick={() => setRange(r)} data-testid={`biz-range-${r}`}>
              {r} days
            </button>
          ))}
        </span>
        <span className="grow" />
        <a className="btn small ghost" href={`/api/business/analytics.csv?range=${range}`} download data-testid="biz-csv">
          Export CSV
        </a>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="biz-tiles">
            {tiles.map(([key, label, value]) => (
              <div key={key} className="biz-tile" data-testid={`biz-${key}`}>
                <small>{label}</small>
                <b>{value}</b>
              </div>
            ))}
          </div>
          <div className="biz-chart card">
            <small className="label">Content views, last {data.rangeDays} days</small>
            <Spark points={data.daily.map((d) => d.views)} label="Content views per day" />
            <small className="label">Followers</small>
            <Spark points={data.daily.map((d) => d.followers)} label="Followers over time" />
          </div>
          <div className="card" data-testid="biz-top">
            <h2>Top content</h2>
            {data.top.length ? (
              <ol className="biz-top">
                {data.top.map((c) => (
                  <li key={`${c.kind}-${c.id}`}>
                    <span className="pill">{c.kind === 'clip' ? 'Clip' : 'Post'}</span> <span className="biz-top-text">{c.text || '(no caption)'}</span>
                    <small className="muted">
                      {count(c.views, 'view')} · {num(c.engagement)} engagement
                    </small>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted small">Nothing yet in this range — post, share a clip, or add a story.</p>
            )}
          </div>
          <p className="small muted">Only your own numbers. Views count once per person per day; engagement is likes and comments from other people.</p>
        </>
      )}
    </div>
  );
}

/* ---------- ads ---------- */

const STATUS: Record<AdCampaign['status'], string> = {
  pending_payment: 'Waiting for payment',
  active: 'Live',
  paused: 'Paused',
  completed: 'Finished',
  rejected: 'Not approved',
  canceled: 'Removed',
};

function Ads({ o, onChange, onNote }: { o: BusinessOverview; onChange: (c: AdCampaign[]) => void; onNote: (n: string) => void }) {
  const [mode, setMode] = useState<'list' | 'boost' | 'campaign'>('list');
  const confirm = useConfirm();
  const act = (c: AdCampaign, action: 'pause' | 'resume'): void =>
    void api<{ campaigns: AdCampaign[] }>(`/api/business/campaigns/${c.id}/${action}`, 'POST').then((r) => onChange(r.campaigns), (e: unknown) => onNote(errText(e, 'Could not update')));
  return (
    <div data-testid="biz-ads">
      <div className="row biz-actions">
        <button type="button" className="btn small" onClick={() => setMode('boost')} data-testid="biz-boost-open">
          Boost a post or clip
        </button>
        <button type="button" className="btn small ghost" onClick={() => setMode('campaign')} data-testid="biz-campaign-open">
          New campaign
        </button>
      </div>
      {mode === 'boost' && <BoostPicker packages={o.packages} onClose={() => setMode('list')} />}
      {mode === 'campaign' && <CampaignForm cpm={o.cpmCents} bookable={!!o.bookable} onClose={() => setMode('list')} />}
      <div className="biz-campaigns" data-testid="biz-campaigns">
        {o.campaigns.map((c) => (
          <article key={c.id} className="card biz-campaign" data-testid="biz-campaign">
            <div className="row">
              <b className="grow">{c.name}</b>
              <span className={`pill biz-status-${c.status}`}>{STATUS[c.status]}</span>
            </div>
            {c.headline && <p className="small">“{c.headline}”</p>}
            <dl className="biz-stats">
              <div>
                <dt>Spend</dt>
                <dd>
                  {money(c.spendCents)} / {money(c.budgetCents)}
                </dd>
              </div>
              <div>
                <dt>Impressions</dt>
                <dd data-testid="biz-impressions">
                  {num(c.impressions)} / {num(c.impressionsBought)}
                </dd>
              </div>
              <div>
                <dt>Clicks</dt>
                <dd data-testid="biz-clicks">
                  {num(c.clicks)}
                  {c.impressions ? ` · ${((c.clicks / c.impressions) * 100).toFixed(1)}%` : ''}
                </dd>
              </div>
              <div>
                <dt>Schedule</dt>
                <dd>
                  {c.startsOn}
                  {c.endsOn ? ` → ${c.endsOn}` : ' →'}
                </dd>
              </div>
            </dl>
            <div className="row">
              {c.status === 'active' && (
                <button type="button" className="link small" onClick={() => act(c, 'pause')}>
                  Pause
                </button>
              )}
              {c.status === 'paused' && (
                <button type="button" className="link small" onClick={() => act(c, 'resume')}>
                  Resume
                </button>
              )}
              {c.status === 'pending_payment' && (
                <button
                  type="button"
                  className="link danger small"
                  onClick={() =>
                    void confirm({ title: 'Remove this unpaid ad?', body: 'Nothing was charged.', confirmLabel: 'Remove', danger: true }).then(
                      (y) => void (y && api<{ campaigns: AdCampaign[] }>(`/api/business/campaigns/${c.id}`, 'DELETE').then((r) => onChange(r.campaigns))),
                    )
                  }
                >
                  Remove
                </button>
              )}
            </div>
          </article>
        ))}
        {!o.campaigns.length && mode === 'list' && <p className="muted small">No ads yet. Boost a post or clip to reach more grown-ups in the Feed — it’s labelled “Sponsored”, and kids never see ads.</p>}
      </div>
    </div>
  );
}

function AdError({ e }: { e: unknown }) {
  if (e instanceof ApiFail && e.code === 'ad_rejected') {
    const reasons = Array.isArray(e.details?.reasons) ? (e.details.reasons as string[]) : [];
    return (
      <div className="card note" role="alert" data-testid="ad-rejected">
        <b>This ad can’t run.</b>
        <ul>
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <small>Ads can describe your services (“ADHD evaluations for adults”, “parent coaching”), but they can’t promise medical results or tell anyone to change medication.</small>
      </div>
    );
  }
  return <p className="error">{errText(e, 'Something went wrong')}</p>;
}

function BoostPicker({ packages, onClose }: { packages: BoostPackage[]; onClose: () => void }) {
  const [me, setMe] = useState<number | null>(null);
  useEffect(() => {
    void api<{ profile: { userId: number } | null }>('/api/community/me').then((r) => setMe(r.profile?.userId ?? null));
  }, []);
  const posts = useLoad<FeedPage>(me ? `/api/feed?author=${me}` : null);
  const clips = useLoad<{ clips: ClipItem[] }>(me ? `/api/social/clips?user=${me}` : null);
  const [target, setTarget] = useState<{ kind: 'post' | 'clip'; id: number } | null>(null);
  const [pkg, setPkg] = useState(packages[1]?.code ?? packages[0]?.code ?? '');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const items = [
    ...(clips.data?.clips.filter((c) => c.status === 'visible').map((c) => ({ kind: 'clip' as const, id: c.id, text: c.caption || '(clip)' })) ?? []),
    ...(posts.data?.posts.filter((p) => p.status === 'visible').map((p) => ({ kind: 'post' as const, id: p.id, text: p.body })) ?? []),
  ];
  return (
    <div className="card biz-form" data-testid="biz-boost">
      <div className="row">
        <h2 className="grow">Boost</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <small className="label">1. What to boost</small>
      <div className="biz-targets">
        {items.map((i) => (
          <label key={`${i.kind}-${i.id}`} className={target?.kind === i.kind && target.id === i.id ? 'biz-target on' : 'biz-target'}>
            <input type="radio" name="boost-target" checked={target?.kind === i.kind && target.id === i.id} onChange={() => setTarget({ kind: i.kind, id: i.id })} data-testid="boost-target" />
            <span className="pill">{i.kind === 'clip' ? 'Clip' : 'Post'}</span> {i.text.slice(0, 90)}
          </label>
        ))}
        {!items.length && <p className="muted small">Post something or share a clip first — then boost it here.</p>}
      </div>
      <small className="label">2. How far</small>
      <div className="biz-packages" role="radiogroup" aria-label="Package">
        {packages.map((p) => (
          <button key={p.code} type="button" role="radio" aria-checked={pkg === p.code} className={pkg === p.code ? 'biz-package on' : 'biz-package'} onClick={() => setPkg(p.code)} data-testid={`boost-pkg-${p.code}`}>
            <b>{p.label}</b>
            <span>{num(p.impressions)} impressions</span>
            <small>{money(p.cents)}</small>
          </button>
        ))}
      </div>
      {err !== null && <AdError e={err} />}
      <button
        type="button"
        className="btn"
        disabled={!target || !pkg || busy}
        data-testid="boost-pay"
        onClick={() => {
          if (!target) return;
          setBusy(true);
          setErr(null);
          void api<{ url: string }>('/api/business/boost', 'POST', { targetKind: target.kind, targetId: target.id, package: pkg })
            .then((r) => go(r.url))
            .catch((e: unknown) => setErr(e))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Checking…' : `Pay ${money(packages.find((p) => p.code === pkg)?.cents ?? 0)} and boost`}
      </button>
      <small className="muted">The words are checked first: no cure claims, guarantees or medication advice. Shown only to grown-ups, labelled “Sponsored”.</small>
    </div>
  );
}

function CampaignForm({ cpm, bookable, onClose }: { cpm: number; bookable: boolean; onClose: () => void }) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const [f, setF] = useState({ name: '', headline: '', body: '', destination: 'profile', destinationUrl: '', budget: '50', startsOn: today, endsOn: '' });
  const [err, setErr] = useState<unknown>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const budgetCents = Math.round(Number(f.budget || 0) * 100);
  const impressions = Math.floor((budgetCents * 1000) / cpm);
  return (
    <form
      className="card biz-form form"
      data-testid="biz-campaign-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        void api<{ url: string }>('/api/business/campaigns', 'POST', {
          name: f.name,
          headline: f.headline,
          body: f.body,
          destination: f.destination,
          destinationUrl: f.destination === 'url' ? f.destinationUrl : undefined,
          budgetCents,
          startsOn: f.startsOn,
          endsOn: f.endsOn || undefined,
        })
          .then((r) => go(r.url))
          .catch((e2: unknown) => setErr(e2))
          .finally(() => setBusy(false));
      }}
    >
      <div className="row">
        <h2 className="grow">New campaign</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <label>
        Campaign name (just for you)
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} data-testid="ad-name" />
      </label>
      <label>
        Headline
        <input value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} required maxLength={80} data-testid="ad-headline" />
      </label>
      <label>
        Text
        <textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required maxLength={300} rows={3} data-testid="ad-body" />
      </label>
      <label>
        Where a tap goes
        <select value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} data-testid="ad-destination">
          <option value="profile">Your profile on the Feed</option>
          {bookable && <option value="consult">Book a consult</option>}
          {bookable && <option value="url">Your website</option>}
        </select>
      </label>
      {f.destination === 'url' && (
        <label>
          Website (https://)
          <input type="url" value={f.destinationUrl} onChange={(e) => setF({ ...f, destinationUrl: e.target.value })} required placeholder="https://" />
        </label>
      )}
      <div className="row">
        <label className="grow">
          Budget ($)
          <input type="number" min={10} max={5000} step={1} value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} required data-testid="ad-budget" />
        </label>
        <label className="grow">
          Starts
          <input type="date" value={f.startsOn} min={today} onChange={(e) => setF({ ...f, startsOn: e.target.value })} />
        </label>
        <label className="grow">
          Ends (optional)
          <input type="date" value={f.endsOn} min={f.startsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} />
        </label>
      </div>
      <small className="muted">
        About {num(impressions)} impressions at {money(cpm)} per thousand.
      </small>
      {checked && (
        <p className="small" role="status" data-testid="ad-check-ok">
          {checked}
        </p>
      )}
      {err !== null && <AdError e={err} />}
      <div className="row">
        <button
          type="button"
          className="btn small ghost"
          data-testid="ad-check"
          onClick={() => {
            setErr(null);
            setChecked(null);
            void api<{ ok: boolean; reasons: string[]; explain: string | null }>('/api/business/ads/check', 'POST', { headline: f.headline, body: f.body }).then((r) =>
              r.ok ? setChecked('✓ Looks good — no medical claims.') : setErr(new ApiFail(422, r.explain ?? 'This ad can’t run', false, 'ad_rejected', { reasons: r.reasons })),
            );
          }}
        >
          Check my ad
        </button>
        <button className="btn small" disabled={busy} data-testid="ad-pay">
          {busy ? 'Checking…' : `Pay ${money(budgetCents)} and launch`}
        </button>
      </div>
    </form>
  );
}

/* ---------- consults ---------- */

function Consults({ slots, onChange }: { slots: ConsultSlot[]; onChange: (s: ConsultSlot[]) => void }) {
  const [f, setF] = useState({ when: '', minutes: '30', price: '0' });
  const [msg, setMsg] = useState<string | null>(null);
  const confirm = useConfirm();
  return (
    <div data-testid="biz-consults">
      <form
        className="card form biz-form"
        onSubmit={(e) => {
          e.preventDefault();
          setMsg(null);
          void api<{ slots: ConsultSlot[] }>('/api/business/slots', 'POST', { startsAt: new Date(f.when).toISOString(), minutes: Number(f.minutes), priceCents: Math.round(Number(f.price || 0) * 100) })
            .then((r) => {
              onChange(r.slots);
              setF({ ...f, when: '' });
            })
            .catch((e2: unknown) => setMsg(errText(e2, 'Could not add the slot')));
        }}
      >
        <h2>Offer a consult time</h2>
        <div className="row">
          <label className="grow">
            When
            <input type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} required data-testid="slot-when" />
          </label>
          <label>
            Minutes
            <input type="number" min={10} max={180} value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} required />
          </label>
          <label>
            Price ($)
            <input type="number" min={0} max={1000} step="0.01" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required data-testid="slot-price" />
          </label>
        </div>
        {msg && <p className="error">{msg}</p>}
        <button className="btn small" data-testid="slot-add">
          Add time
        </button>
        <small className="muted">People book from your provider page. You’ll see who booked here; arrange the call by message.</small>
      </form>
      <div className="biz-slots" data-testid="biz-slots">
        {slots.map((s) => (
          <div key={s.id} className="row biz-slot" data-testid="biz-slot">
            <span className="grow">
              <b>{new Date(s.startsAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</b> · {s.minutes} min · {s.priceCents ? money(s.priceCents) : 'Free'}
            </span>
            {s.status === 'booked' ? (
              <span className="pill">Booked{s.bookedBy ? ` by ${s.bookedBy}` : ''}</span>
            ) : s.status === 'held' ? (
              <span className="pill sun">Being booked…</span>
            ) : (
              <button
                type="button"
                className="link danger small"
                onClick={() =>
                  void confirm({ title: 'Remove this time?', confirmLabel: 'Remove', danger: true }).then(
                    (y) => void (y && api<{ slots: ConsultSlot[] }>(`/api/business/slots/${s.id}`, 'DELETE').then((r) => onChange(r.slots))),
                  )
                }
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {!slots.length && <p className="muted small">No consult times yet.</p>}
      </div>
      <p className="small muted">
        Bookings and revenue show up in <Link to="/business?tab=analytics">Analytics</Link>.
      </p>
    </div>
  );
}
