import { useState, type FormEvent } from 'react';
import type { Curfew, EarnResult, FamilyResponse, KidOverview, NewOneOnOne, PartnerCheckinFields } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useToast } from '../../components/useToast';
import { ago } from '../../dates';
import { KidAiConsent } from '../settings/YourData';

type EarnFamily = EarnResult & { family: FamilyResponse };

const CURFEW_FIELDS: Array<[keyof Curfew, string]> = [
  ['curfewWeekday', 'Curfew (Sun–Thu)'],
  ['curfewWeekend', 'Curfew (Fri–Sat)'],
  ['phoneOffWeekday', 'Phone off (Sun–Thu)'],
  ['phoneOffWeekend', 'Phone off (Fri–Sat)'],
];

function KidCard({ k, onCurfew }: { k: KidOverview; onCurfew: (field: keyof Curfew, value: string) => void }) {
  return (
    <div className="card" data-testid={`kid-${k.member.key}`}>
      <div className="ex-head">
        <b>{k.member.name}</b>
        <small className="muted">{k.lastSignIn ? ` · signed in ${ago(k.lastSignIn)}` : ' · not signed in yet'}</small>
      </div>
      <div className="stats">
        <div className="stat">
          <b>
            {k.choresDone}/{k.choresToday}
          </b>
          <small>chores</small>
        </div>
        <div className="stat">
          <b>{k.pointsToday}</b>
          <small>pts today</small>
        </div>
        <div className="stat">
          <b>{k.bank}</b>
          <small>to spend</small>
        </div>
      </div>
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
    </div>
  );
}

/** Partner check-in, the kids at a glance (with curfews), and 1-on-1 time. */
export default function Family() {
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
    <section>
      <h1>Family</h1>

      <KidAiConsent />
      <h2>The kids</h2>
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

      <form className="card form" onSubmit={(e) => void savePartner(e)}>
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
