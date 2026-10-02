import { useState, type FormEvent } from 'react';
import { ENERGIES, type DumpResponse, type Energy, type TriageRequest } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';

/** Empty your head here, then sort each note into a task or "handled". */
export default function BrainDump() {
  const { isAdult } = useSession();
  const { data, error, setData } = useLoad<DumpResponse>('/api/dump');
  const [note, setNote] = useState('');
  const [energy, setEnergy] = useState<Energy>('Low Brain');
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const capture = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setData(await api<DumpResponse>('/api/dump', 'POST', { note }));
    setNote('');
  };
  const triage = async (id: number, to: TriageRequest['to']): Promise<void> => {
    const body: TriageRequest = { to, energy };
    setData(await api<DumpResponse>(`/api/dump/${id}/triage`, 'POST', body));
  };

  return (
    <section>
      <h1>🧠 Brain dump</h1>
      <form className="inline" onSubmit={(e) => void capture(e)}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Whatever's rattling around…" required autoFocus />
        <button className="btn small">Dump</button>
      </form>
      <h2>Inbox ({data.open.length})</h2>
      {isAdult && data.open.length > 0 && (
        <div className="chips">
          <small className="muted">New tasks are:</small>
          {ENERGIES.map((en) => (
            <button key={en} className={energy === en ? 'chip on' : 'chip'} onClick={() => setEnergy(en)}>
              {en}
            </button>
          ))}
        </div>
      )}
      {data.open.length === 0 && <p className="muted">Inbox zero. Head's clear.</p>}
      <ul className="plain rows" data-testid="dump-inbox">
        {data.open.map((d) => (
          <li key={d.id}>
            <span>
              {d.note} <small className="muted">· {d.capturedOn}</small>
            </span>
            <span>
              {isAdult && (
                <button className="btn small" onClick={() => void triage(d.id, 'task')}>
                  → Task
                </button>
              )}{' '}
              <button className="link" onClick={() => void triage(d.id, 'done')}>
                Handled
              </button>
            </span>
          </li>
        ))}
      </ul>
      {data.triaged.length > 0 && (
        <>
          <h2>Sorted</h2>
          <ul className="plain rows">
            {data.triaged.map((d) => (
              <li key={d.id} className="muted">
                <span>{d.note}</span>
                <small>{d.status === 'task' ? 'became a task' : 'handled'}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
