import { useState } from 'react';
import type { HouseholdSurvey, IdentityResponse, MentalLoadRow } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';

const DIMS: Array<[keyof HouseholdSurvey, string]> = [
  ['presence', 'Presence'],
  ['reliability', 'Reliability'],
  ['emotional', 'Emotional support'],
  ['followThrough', 'Follow-through'],
  ['communication', 'Communication'],
];

function AnchorForm({ data, onSave }: { data: IdentityResponse; onSave: (a: Record<string, string>) => Promise<void> }) {
  const [a, setA] = useState<Record<string, string>>(data.anchor);
  return (
    <div className="form">
      {data.fields.map((f) => (
        <label key={f}>
          {f}
          <input value={a[f] ?? ''} maxLength={500} onChange={(e) => setA({ ...a, [f]: e.target.value })} />
        </label>
      ))}
      <button className="btn small" onClick={() => void onSave(a)}>
        Save anchor ✓
      </button>
    </div>
  );
}

function ReviewForm({ data, onSave }: { data: IdentityResponse; onSave: (answers: string[]) => Promise<void> }) {
  const cur = data.reviews.find((r) => r.month === data.month);
  const [ans, setAns] = useState<string[]>(cur?.answers ?? data.questions.map(() => ''));
  return (
    <div className="form">
      {data.questions.map((q, i) => (
        <label key={q}>
          {q}
          <textarea value={ans[i] ?? ''} maxLength={600} onChange={(e) => setAns(ans.map((x, j) => (j === i ? e.target.value : x)))} />
        </label>
      ))}
      <button className="btn small" onClick={() => void onSave(ans)}>
        Save {data.month} review ✓
      </button>
    </div>
  );
}

function SurveyForm({ data, onSave }: { data: IdentityResponse; onSave: (s: Omit<HouseholdSurvey, 'weekStart'>) => Promise<void> }) {
  const s = data.survey;
  const [v, setV] = useState({
    presence: s?.presence ?? 3,
    reliability: s?.reliability ?? 3,
    emotional: s?.emotional ?? 3,
    followThrough: s?.followThrough ?? 3,
    communication: s?.communication ?? 3,
    moreOf: s?.moreOf ?? '',
    improved: s?.improved ?? '',
    workOn: s?.workOn ?? '',
  });
  return (
    <div className="form">
      {DIMS.map(([k, label]) => (
        <label key={k}>
          {label}: {v[k as keyof typeof v]}
          <input type="range" min={1} max={5} value={Number(v[k as keyof typeof v])} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
        </label>
      ))}
      <label>
        Do more of
        <input value={v.moreOf} maxLength={200} onChange={(e) => setV({ ...v, moreOf: e.target.value })} />
      </label>
      <label>
        Improved lately
        <input value={v.improved} maxLength={200} onChange={(e) => setV({ ...v, improved: e.target.value })} />
      </label>
      <label>
        Work on
        <input value={v.workOn} maxLength={200} onChange={(e) => setV({ ...v, workOn: e.target.value })} />
      </label>
      <button className="btn small" onClick={() => void onSave(v)}>
        Save this week ✓
      </button>
    </div>
  );
}

function LoadRow({ r, onSave }: { r: MentalLoadRow; onSave: (r: MentalLoadRow) => Promise<void> }) {
  const [row, setRow] = useState(r);
  return (
    <li>
      <span className="grow">
        <b>{r.category}</b>
      </span>
      <select aria-label={`${r.category} load`} value={row.load} onChange={(e) => setRow({ ...row, load: e.target.value as MentalLoadRow['load'] })}>
        <option value="">—</option>
        <option>Light</option>
        <option>Medium</option>
        <option>Heavy</option>
      </select>
      <input aria-label={`${r.category} owner`} placeholder="Who carries it" style={{ maxWidth: 120 }} value={row.owner} onChange={(e) => setRow({ ...row, owner: e.target.value })} />
      <label className="small">
        <input type="checkbox" checked={row.delegate} onChange={(e) => setRow({ ...row, delegate: e.target.checked })} /> delegated
      </label>
      <button className="btn small" onClick={() => void onSave(row)}>
        Save
      </button>
    </li>
  );
}

/** Identity tools: anchor, monthly review, the weekly head-of-household survey, the mental-load tracker. */
export default function Identity() {
  const { members, me } = useSession();
  const { data, error, setData } = useLoad<IdentityResponse>('/api/identity');
  const [msg, setMsg] = useState<string | null>(null);
  const [newCat, setNewCat] = useState('');
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const run = async (p: Promise<IdentityResponse>, ok: string): Promise<void> => {
    try {
      setData(await p);
      setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const partnered = members.filter((m) => m.kind === 'adult').length > 1 && me.xpTrack !== 'student';

  return (
    <section>
      <h1>Identity</h1>
      {msg && <p className="muted" role="status">{msg}</p>}
      <details className="card" open={Object.keys(data.anchor).length === 0}>
        <summary>
          <b>🪞 Identity anchor</b>
        </summary>
        <AnchorForm data={data} onSave={(anchor) => run(api('/api/identity/anchor', 'PUT', { anchor }), 'Anchor saved ✓')} />
      </details>
      <details className="card" data-testid="identity-review">
        <summary>
          <b>Monthly review</b> <span className="muted small">{data.month}</span>
        </summary>
        <ReviewForm data={data} onSave={(answers) => run(api('/api/identity/review', 'PUT', { month: data.month, answers }), 'Review saved ✓ +30 XP')} />
        {data.reviews
          .filter((r) => r.month !== data.month)
          .map((r) => (
            <details key={r.month}>
              <summary>{r.month}</summary>
              <ol className="small">
                {r.answers.map((a, i) => (
                  <li key={i}>{a || '—'}</li>
                ))}
              </ol>
            </details>
          ))}
      </details>
      {partnered && (
        <details className="card" data-testid="hoh-survey">
          <summary>
            <b>How the head of household showed up</b> <span className="muted small">this week, 1–5</span>
          </summary>
          <SurveyForm data={data} onSave={(s) => run(api('/api/identity/survey', 'PUT', s), 'Survey saved ✓')} />
        </details>
      )}
      <details className="card" data-testid="mental-load">
        <summary>
          <b>🧠 Mental load</b> <span className="muted small">who carries what at home</span>
        </summary>
        <ul className="plain rows">
          {data.mentalLoad.map((r) => (
            <LoadRow key={r.id} r={r} onSave={(row) => run(api(`/api/identity/load/${r.id}`, 'PATCH', row), `${r.category} saved ✓`)} />
          ))}
        </ul>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api('/api/identity/load', 'POST', { category: newCat }), 'Added ✓').then(() => setNewCat(''));
          }}
        >
          <input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Another category" required maxLength={60} />
          <button className="btn small">Add</button>
        </form>
      </details>
    </section>
  );
}
