/**
 * C7 in Family HQ: health logistics — medications and their supply, recurring care, and the prep
 * pack for each visit. Organization only: what the family entered, never a reading of it.
 */
import { useState, type FormEvent } from 'react';
import type { HealthLogistics, Medication, PrepPack } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';

const day = (d: string): string => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function Refill({ m, onDone }: { m: Medication; onDone: (p: Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState('');
  if (!open) {
    return (
      <button className="link small" onClick={() => setOpen(true)} data-testid="med-refill-open">
        Log refill
      </button>
    );
  }
  return (
    <form
      className="inline"
      onSubmit={(e) => {
        e.preventDefault();
        void onDone(api(`/api/health/medications/${m.id}/refill`, 'POST', { amount: Number(n) })).then(() => setOpen(false));
      }}
    >
      <input value={n} onChange={(e) => setN(e.target.value)} inputMode="decimal" placeholder="How many came home" aria-label="How many came home" autoFocus />
      <button className="btn small" disabled={!(Number(n) > 0)} data-testid="med-refill-save">
        Save
      </button>
      <button type="button" className="link small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

function Pack({ p, onDone }: { p: PrepPack; onDone: (p: Promise<unknown>) => Promise<void> }) {
  const [q, setQ] = useState('');
  const add = (e: FormEvent): void => {
    e.preventDefault();
    if (!q.trim()) return;
    void onDone(api(`/api/health/visits/${encodeURIComponent(p.visitKey)}/questions`, 'POST', { question: q.trim(), member: p.memberId ? p.member : null })).then(() => setQ(''));
  };
  return (
    <li className="prep-pack" data-testid="prep-pack">
      <b>
        {p.member === 'the family' ? '' : `${p.member} · `}
        {p.title}
      </b>{' '}
      <span className="muted small">
        {day(p.date)}
        {p.time ? ` ${p.time.slice(0, 5)}` : ''}
        {p.location ? ` · ${p.location}` : ''}
      </span>
      {p.questions.length > 0 && (
        <ul className="plain">
          {p.questions.map((x) => (
            <li key={x.id} data-testid="prep-question">
              ? {x.question}{' '}
              <button className="link danger small" onClick={() => void onDone(api(`/api/health/questions/${x.id}`, 'DELETE'))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {p.medications.length > 0 && <p className="small">Medications: {p.medications.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}`).join(', ')}</p>}
      {p.records.length > 0 && <p className="small">Bring or mention: {p.records.map((r) => r.what).join('; ')}</p>}
      {p.memberId && (
        <form className="inline" onSubmit={add}>
          <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} placeholder="A question to ask…" aria-label={`Question for ${p.member}'s visit`} />
          <button className="btn small ghost" disabled={!q.trim()} data-testid="prep-question-add">
            Add
          </button>
        </form>
      )}
      <p className="muted small">{p.rail}</p>
    </li>
  );
}

export function CareLogisticsCard() {
  const { members } = useSession();
  const { data, setData, reload } = useLoad<HealthLogistics>('/api/health/logistics');
  const [err, setErr] = useState<string | null>(null);
  const [med, setMed] = useState({ memberId: '', name: '', dose: '', schedule: '', perDay: '', supply: '', refillsLeft: '', pharmacy: '' });
  const [care, setCare] = useState({ memberId: '', what: '', everyMonths: '6', lastOn: '' });
  if (!data) return null;
  const run = async (p: Promise<unknown>): Promise<void> => {
    setErr(null);
    try {
      await p;
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t save');
    }
  };
  const addMed = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const n = (s: string): number | null => (s.trim() ? Number(s) : null);
    await run(
      api<HealthLogistics>('/api/health/medications', 'POST', {
        memberId: Number(med.memberId),
        name: med.name.trim(),
        dose: med.dose.trim(),
        schedule: med.schedule.trim(),
        perDay: n(med.perDay),
        supply: n(med.supply),
        refillsLeft: n(med.refillsLeft),
        pharmacy: med.pharmacy.trim(),
      }).then((r) => setData({ ...data, medications: r.medications })),
    );
    setMed({ memberId: '', name: '', dose: '', schedule: '', perDay: '', supply: '', refillsLeft: '', pharmacy: '' });
  };
  const addCare = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    await run(api('/api/health/care', 'POST', { memberId: Number(care.memberId), what: care.what.trim(), everyMonths: Number(care.everyMonths), lastOn: care.lastOn || null }));
    setCare({ memberId: '', what: '', everyMonths: '6', lastOn: '' });
  };
  const who = (
    <>
      <option value="">Who…</option>
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </>
  );
  return (
    <div className="card care-logistics" data-testid="hq-care">
      <h2>Appointments, meds & refills</h2>
      <p className="muted small">Organized from what you enter — Hana never reads anything medical into it. A clinician is the right call for anything medical.</p>

      <h3 className="ing-head">Coming up (prep packs)</h3>
      {!data.visits.length && <p className="muted small">No appointments on the calendar in the next two weeks.</p>}
      <ul className="plain rows">
        {data.visits.map((p) => (
          <Pack key={`${p.visitKey}:${p.memberId ?? 0}`} p={p} onDone={run} />
        ))}
      </ul>

      <h3 className="ing-head">Medications</h3>
      <ul className="plain rows">
        {data.medications.map((m) => (
          <li key={m.id} className={m.low ? 'med low' : 'med'} data-testid="med">
            <span>
              <b>{m.member}</b> · {m.name}
              {m.dose ? ` ${m.dose}` : ''}
              {m.schedule ? `, ${m.schedule}` : ''}
              <small className="muted"> · {m.status}</small>
            </span>
            <span className="mem-tools">
              {m.active && <Refill m={m} onDone={run} />}
              <button className="link danger small" onClick={() => void run(api(`/api/health/medications/${m.id}`, 'DELETE'))}>
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      <form className="inline wrap" onSubmit={(e) => void addMed(e)}>
        <select value={med.memberId} onChange={(e) => setMed({ ...med, memberId: e.target.value })} aria-label="Whose medication">
          {who}
        </select>
        <input value={med.name} onChange={(e) => setMed({ ...med, name: e.target.value })} placeholder="Medication" aria-label="Medication name" />
        <input value={med.dose} onChange={(e) => setMed({ ...med, dose: e.target.value })} placeholder="Dose, as on the label" aria-label="Dose" />
        <input value={med.schedule} onChange={(e) => setMed({ ...med, schedule: e.target.value })} placeholder="When (as prescribed)" aria-label="Schedule" />
        <input value={med.supply} onChange={(e) => setMed({ ...med, supply: e.target.value })} inputMode="decimal" placeholder="On hand" aria-label="Supply on hand" />
        <input value={med.perDay} onChange={(e) => setMed({ ...med, perDay: e.target.value })} inputMode="decimal" placeholder="Per day" aria-label="How many a day" />
        <input value={med.refillsLeft} onChange={(e) => setMed({ ...med, refillsLeft: e.target.value })} inputMode="numeric" placeholder="Refills left" aria-label="Refills left" />
        <input value={med.pharmacy} onChange={(e) => setMed({ ...med, pharmacy: e.target.value })} placeholder="Pharmacy" aria-label="Pharmacy" />
        <button className="btn small ghost" disabled={!med.memberId || !med.name.trim()} data-testid="med-add">
          Add
        </button>
      </form>

      <h3 className="ing-head">Recurring care</h3>
      <ul className="plain rows">
        {data.care.map((c) => (
          <li key={c.id} data-testid="care-item">
            <span>
              <b>{c.member}</b> · {c.what} <small className="muted">· {c.status}</small>
            </span>
            <span className="mem-tools">
              <button className="link small" onClick={() => void run(api(`/api/health/care/${c.id}`, 'PUT', { lastOn: new Date().toISOString().slice(0, 10) }))} data-testid="care-done">
                Went today
              </button>
              <button className="link danger small" onClick={() => void run(api(`/api/health/care/${c.id}`, 'DELETE'))}>
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      <form className="inline wrap" onSubmit={(e) => void addCare(e)}>
        <select value={care.memberId} onChange={(e) => setCare({ ...care, memberId: e.target.value })} aria-label="Who the care is for">
          {who}
        </select>
        <input value={care.what} onChange={(e) => setCare({ ...care, what: e.target.value })} placeholder="e.g. dental cleaning" aria-label="What care" />
        <input value={care.everyMonths} onChange={(e) => setCare({ ...care, everyMonths: e.target.value })} inputMode="numeric" aria-label="Every how many months" />
        <input type="date" value={care.lastOn} onChange={(e) => setCare({ ...care, lastOn: e.target.value })} aria-label="Last visit" />
        <button className="btn small ghost" disabled={!care.memberId || !care.what.trim()} data-testid="care-add">
          Add
        </button>
      </form>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}
