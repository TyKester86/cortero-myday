import { useState, type FormEvent } from 'react';
import { liveFeatures, type Curfew, type EarnResult, type FamilyResponse, type KidOverview, type NewOneOnOne, type PartnerCheckinFields } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useToast } from '../../components/useToast';
import { ago } from '../../dates';
import { useSession } from '../../session';
import { NavIcon } from '../../components/NavIcon';
import { count } from '../../format';
import { HomeworkHelpStyle, KidAiConsent } from '../settings/YourData';

type EarnFamily = EarnResult & { family: FamilyResponse };

const CURFEW_FIELDS: Array<[keyof Curfew, string]> = [
  ['curfewWeekday', 'Curfew (Sun–Thu)'],
  ['curfewWeekend', 'Curfew (Fri–Sat)'],
  ['phoneOffWeekday', 'Phone off (Sun–Thu)'],
  ['phoneOffWeekend', 'Phone off (Fri–Sat)'],
];

/** A kid in the household list: avatar ring, name, today's progress; details (stats, homework, curfews) fold out. */
function KidCard({ k, onCurfew }: { k: KidOverview; onCurfew: (field: keyof Curfew, value: string) => void }) {
  const pct = k.choresToday ? Math.round((k.choresDone / k.choresToday) * 100) : 0;
  return (
    <li className="row-card member-card" data-testid={`kid-${k.member.key}`}>
      <span className="ring-avatar" aria-hidden="true">
        {k.member.name.slice(0, 1)}
      </span>
      <span>
        <h3 className="member-name">{k.member.name}</h3>
        <span className="member-line">
          <span className="ring" style={{ ['--p' as string]: pct }} aria-hidden="true" />
          {pct}% • {k.pointsToday} pts
        </span>
      </span>
      <details>
        <summary>Details</summary>
        <small className="muted">
          Chores {k.choresDone}/{k.choresToday} · {k.bank} to spend{k.lastSignIn ? ` · signed in ${ago(k.lastSignIn)}` : ' · not signed in yet'}
        </small>
        <br />
        <small className={k.overdueHomework ? 'warn' : 'muted'}>
          {k.openHomework} homework open{k.overdueHomework ? ` (${k.overdueHomework} overdue)` : ''}
          {k.pendingRewards > 0 && ` · ${k.pendingRewards} reward request${k.pendingRewards > 1 ? 's' : ''} waiting`}
        </small>
        <div className="curfews">
          {CURFEW_FIELDS.map(([f, label]) => (
            <label key={f}>
              <small>{label}</small>
              <input type="time" defaultValue={k.curfew[f]} onBlur={(e) => e.target.value !== k.curfew[f] && onCurfew(f, e.target.value)} />
            </label>
          ))}
        </div>
      </details>
    </li>
  );
}

/** Partner check-in, the kids at a glance (with curfews), and 1-on-1 time. */
export default function Family() {
  const { me, members } = useSession();
  const live = me.household ? liveFeatures(me.household) : { kids: true, partner: true, family: true };
  const { data, error, setData } = useLoad<FamilyResponse>('/api/family');
  const { toast, show } = useToast();
  const [partner, setPartner] = useState<PartnerCheckinFields | null>(null);
  const [one, setOne] = useState<NewOneOnOne>({ childId: 0, minutes: 20, promiseKept: false, moment: false, reflection: '', word: '' });
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const p: PartnerCheckinFields = partner ??
    (data.partner
      ? { ...data.partner }
      : { positives: 0, negatives: 0, connection: '', conflict: false, flooded: false, tookBreak: false, need: '' });
  const childId = one.childId || data.kids[0]?.member.id || 0;
  const doneToday = data.kids.reduce((n, k) => n + k.choresDone, 0);
  const choresToday = data.kids.reduce((n, k) => n + k.choresToday, 0);
  const ptsToday = data.kids.reduce((n, k) => n + k.pointsToday, 0);

  const savePartner = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const r = await api<EarnFamily>('/api/family/partner', 'PUT', p);
    setData(r.family);
    setPartner(null);
    show('Check-in saved');
  };
  const logOne = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const r = await api<EarnFamily>('/api/family/one-on-ones', 'POST', { ...one, childId });
    setData(r.family);
    setOne({ ...one, reflection: '', word: '' });
    show('1-on-1 logged 💛');
  };

  return (
    <section className="family">
      <header className="page-head">
        <h1 className="page-title">Family</h1>
      </header>
      <h2 className="eyebrow">Household</h2>
      <ul className="row-list" data-testid="household-members">
        {members
          .filter((m) => m.kind === 'adult')
          .map((m) => (
            <li key={m.id} className="row-card member-card">
              <span className="ring-avatar" aria-hidden="true">
                {m.name.slice(0, 1)}
              </span>
              <span>
                <h3 className="member-name">{m.name}</h3>
                <span className="member-line">{m.id === me.member?.id ? 'You · grown-up' : 'Grown-up'}</span>
              </span>
            </li>
          ))}
        {data.kids.map((k) => (
          <KidCard
            key={k.member.id}
            k={k}
            onCurfew={(f, v) =>
              void api<FamilyResponse>(`/api/family/curfews/${k.member.id}`, 'PUT', { [f]: v }).then((d) => {
                setData(d);
                show('Saved');
              })
            }
          />
        ))}
      </ul>
      {data.kids.length > 0 && (
        <div className="sage-card banner-card" data-testid="family-banner">
          <span className="banner-icon">
            <NavIcon name="sparkle" size={34} />
          </span>
          <span>
            <h2>{doneToday > 0 ? 'Great teamwork today!' : 'A fresh start today'}</h2>
            <span>
              {doneToday > 0
                ? `The kids finished ${count(doneToday, 'chore')} so far. +${ptsToday} points earned.`
                : `${count(choresToday, 'chore')} on the board today — first one gets the ball rolling.`}
            </span>
          </span>
        </div>
      )}

      {data.kids.length > 0 && <h2 className="eyebrow">For the kids</h2>}
      {data.kids.length > 0 && <KidAiConsent />}
      {data.kids.length > 0 && <HomeworkHelpStyle />}

      {live.partner && (
        <form className="card form" onSubmit={(e) => void savePartner(e)} data-testid="partner-checkin">
          <h2>💑 Partner check-in · week of {data.weekStart}</h2>
          {data.partner && <p className="muted">Ratio this week: {data.partner.ratio} (aim for 5:1)</p>}
          <div className="inline">
            <label>
              Positives
              <input type="number" min={0} value={p.positives} onChange={(e) => setPartner({ ...p, positives: Number(e.target.value) })} />
            </label>
            <label>
              Negatives
              <input type="number" min={0} value={p.negatives} onChange={(e) => setPartner({ ...p, negatives: Number(e.target.value) })} />
            </label>
          </div>
          <label>
            Connection moment
            <input value={p.connection} onChange={(e) => setPartner({ ...p, connection: e.target.value })} />
          </label>
          <div className="chips">
            {([['conflict', 'We had conflict'], ['flooded', 'I got flooded'], ['tookBreak', 'I took a break']] as const).map(([k, label]) => (
              <button type="button" key={k} className={p[k] ? 'chip on' : 'chip'} onClick={() => setPartner({ ...p, [k]: !p[k] })}>
                {label}
              </button>
            ))}
          </div>
          <label>
            What I need
            <input value={p.need} onChange={(e) => setPartner({ ...p, need: e.target.value })} />
          </label>
          <button className="btn">Save check-in</button>
        </form>
      )}

      {data.kids.length > 0 && (
        <form className="card form" onSubmit={(e) => void logOne(e)}>
          <h2>👨‍👧 1-on-1 time</h2>
          <label>
            With
            <select value={childId} onChange={(e) => setOne({ ...one, childId: Number(e.target.value) })}>
              {data.kids.map((k) => (
                <option key={k.member.id} value={k.member.id}>
                  {k.member.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Minutes
            <input type="number" min={0} value={one.minutes} onChange={(e) => setOne({ ...one, minutes: Number(e.target.value) })} />
          </label>
          <div className="chips">
            <button type="button" className={one.promiseKept ? 'chip on' : 'chip'} onClick={() => setOne({ ...one, promiseKept: !one.promiseKept })}>
              Kept a promise
            </button>
            <button type="button" className={one.moment ? 'chip on' : 'chip'} onClick={() => setOne({ ...one, moment: !one.moment })}>
              Real moment
            </button>
          </div>
          <label>
            Reflection
            <input value={one.reflection} onChange={(e) => setOne({ ...one, reflection: e.target.value })} />
          </label>
          <label>
            One word for it
            <input value={one.word} onChange={(e) => setOne({ ...one, word: e.target.value })} />
          </label>
          <button className="btn">Log it</button>
        </form>
      )}
      {data.oneOnOnes.length > 0 && (
        <ul className="plain rows" data-testid="one-on-ones">
          {data.oneOnOnes.map((o) => (
            <li key={o.id}>
              <span>
                {o.childName} · {o.minutes} min {o.word && <small className="muted">· “{o.word}”</small>}
              </span>
              <small className="muted">{o.loggedOn}</small>
            </li>
          ))}
        </ul>
      )}
      {toast}
    </section>
  );
}
