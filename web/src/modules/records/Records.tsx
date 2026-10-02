import { useState } from 'react';
import { useLoad } from '../../api';

interface RecordRow {
  kind: string;
  date: string;
  title: string;
  detail: string;
}

const LABEL: Record<string, string> = {
  checkin: 'Check-ins',
  review: 'Reviews',
  workout: 'Workouts',
  note: 'Notes',
  money: 'Money',
  study: 'Study',
  partner: 'Partner',
  one_on_one: '1-on-1s',
  restart: 'Restarts',
};

/** Everything you've logged, newest first — filter, search, export. */
export default function Records() {
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [days, setDays] = useState(90);
  const qs = new URLSearchParams({ days: String(days), ...(kind ? { kind } : {}), ...(q ? { q } : {}) }).toString();
  const { data, error } = useLoad<{ kinds: string[]; records: RecordRow[] }>(`/api/records?${qs}`);
  return (
    <section>
      <h1>Records</h1>
      <div className="chips">
        <button className={kind === '' ? 'chip on' : 'chip'} onClick={() => setKind('')}>
          All
        </button>
        {(data?.kinds ?? Object.keys(LABEL)).map((k) => (
          <button key={k} className={kind === k ? 'chip on' : 'chip'} onClick={() => setKind(k)}>
            {LABEL[k] ?? k}
          </button>
        ))}
      </div>
      <div className="inline">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range">
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>1 year</option>
          <option value={3650}>All</option>
        </select>
        <a className="btn small ghost" href={`/api/records.csv?${qs}`} download>
          CSV
        </a>
      </div>
      {error && <p className="error">{error}</p>}
      {data?.records.length === 0 && <p className="muted">Nothing logged in this range yet.</p>}
      <ul className="plain rows" data-testid="records">
        {data?.records.map((r, i) => (
          <li key={i} style={{ alignItems: 'flex-start' }}>
            <span>
              <b>{r.title}</b> <span className="pill">{LABEL[r.kind] ?? r.kind}</span>
              {r.detail && (
                <>
                  <br />
                  <small className="muted">{r.detail}</small>
                </>
              )}
            </span>
            <small className="muted">{r.date}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
