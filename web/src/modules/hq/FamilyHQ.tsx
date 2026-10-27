import { useState } from 'react';
import { CRISIS_RESOURCES, type HanaAlert, type HanaFamilyReport } from '@myday/shared';
import { api, useLoad } from '../../api';
import { HanaFace } from '../../components/NavIcon';
import { HanaBriefCard } from './HanaBrief';

const thisMonth = (): string => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
};

/** Crisis first, then anything Hana is watching that still needs someone. */
function Alerts() {
  const { data, setData } = useLoad<{ alerts: HanaAlert[] }>('/api/hana/alerts');
  if (!data || !data.alerts.length) return null;
  const done = async (id: number): Promise<void> => {
    await api(`/api/hana/items/${id}/outcome`, 'POST', { outcome: 'acted' });
    setData({ alerts: data.alerts.filter((a) => a.id !== id) });
  };
  return (
    <div className="hq-alerts" data-testid="hq-alerts">
      {data.alerts.map((a) => (
        <div key={a.id} className={`card hq-alert ${a.kind}`} role={a.kind === 'crisis' ? 'alert' : undefined} data-testid={`hq-alert-${a.kind}`}>
          <p>{a.text}</p>
          {a.kind === 'crisis' && (
            <ul className="crisis-resources">
              {CRISIS_RESOURCES.map((r) => (
                <li key={r.href}>
                  <a href={r.href}>{r.label}</a>
                </li>
              ))}
            </ul>
          )}
          <small className="muted">
            {a.source}
            {a.asOf ? ` · ${new Date(a.asOf).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
          </small>
          <button type="button" className="btn small" onClick={() => void done(a.id)}>
            {a.kind === 'crisis' ? 'I’ve checked in' : 'Handled'}
          </button>
        </div>
      ))}
    </div>
  );
}

/** The monthly family report: parents only, and Hana's mistakes sit right next to her wins. */
function Report() {
  const [month, setMonth] = useState(thisMonth());
  const { data } = useLoad<HanaFamilyReport>(`/api/hana/report?month=${month}`);
  return (
    <div className="card" data-testid="hq-report">
      <h2>Family report</h2>
      <label>
        Month <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </label>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <dl className="hq-needle">
            <dt>Homework on time</dt>
            <dd>{data.homework.rate === null ? 'Nothing was due yet' : `${data.homework.rate}% (${data.homework.onTime} of ${data.homework.due})`}</dd>
            <dt>Missed logistics</dt>
            <dd>
              {data.logistics.missed} ({data.logistics.unownedPickups} pickup{data.logistics.unownedPickups === 1 ? '' : 's'} nobody took, {data.logistics.watchUnhandled} alert
              {data.logistics.watchUnhandled === 1 ? '' : 's'} not handled)
            </dd>
            <dt>Brief items acted on</dt>
            <dd>{data.briefs.rate === null ? 'No briefs yet' : `${data.briefs.rate}% (${data.briefs.acted} of ${data.briefs.shown})`}</dd>
            <dt>Nudges set aside</dt>
            <dd>{data.nudges.shown ? `${data.nudges.dismissed} of ${data.nudges.shown}` : 'None yet'}</dd>
          </dl>
          {data.wins.length > 0 && (
            <>
              <h3>What went well</h3>
              <ul>
                {data.wins.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </>
          )}
          <h3>Where Hana was wrong</h3>
          {data.wrong.length ? (
            <ul data-testid="hq-wrong">
              {data.wrong.map((w, i) => (
                <li key={i}>
                  {w.date}: {w.text} <small className="muted">({w.source})</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing marked wrong this month. Tap “That’s wrong” on anything she gets wrong — it shows up here.</p>
          )}
        </>
      )}
    </div>
  );
}

/** Family HQ (parents): Hana's view of the whole household. Read-only — she never sends, spends or commits anything. */
export default function FamilyHQ() {
  return (
    <section data-testid="family-hq">
      <h1 className="hq-title">
        <HanaFace size={32} /> Family HQ
      </h1>
      <p className="muted">Hana’s look at the whole family: today, what’s coming, and anything that needs someone.</p>
      <Alerts />
      <HanaBriefCard />
      <Report />
    </section>
  );
}
