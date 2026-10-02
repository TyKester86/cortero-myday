import { useState } from 'react';
import type { RedAlertDone, RedAlertRequest, RedAlertResponse } from '@myday/shared';
import { api, useLoad } from '../../api';

/** The restart protocol for a day that went sideways: a few tiny steps, no shame. */
export default function RedAlert() {
  const { data, error, reload } = useLoad<RedAlertResponse>('/api/red-alert');
  const [done, setDone] = useState<boolean[]>([]);
  const [trigger, setTrigger] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const finish = async (): Promise<void> => {
    const body: RedAlertRequest = { trigger, note, stepsDone: done.filter(Boolean).length };
    const r = await api<RedAlertDone>('/api/red-alert', 'POST', body);
    setMessage(r.message);
    setDone([]);
    setTrigger('');
    setNote('');
    reload();
  };

  return (
    <section className="redalert">
      <h1>🚨 Red Alert</h1>
      <p className="muted">Off the rails? That happens. Do these, in order. That's the whole job today.</p>
      {message && (
        <div className="card current" data-testid="red-done">
          <p>{message}</p>
        </div>
      )}
      <label className="form">
        What happened? (optional)
        <input value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder="Overslept, a hard call, everything at once…" />
      </label>
      <ul className="checklist">
        {data.steps.map((s, i) => (
          <li key={s} className={done[i] ? 'done' : ''}>
            <label>
              <input
                type="checkbox"
                checked={done[i] ?? false}
                onChange={(e) => {
                  const next = [...done];
                  next[i] = e.target.checked;
                  setDone(next);
                }}
              />
              <span className="name">
                {i + 1}. {s}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <label className="form">
        Note to tomorrow-you
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button className="btn" onClick={() => void finish()}>
        Minimum viable day: done
      </button>
      {data.recent.length > 0 && (
        <>
          <h2>Past restarts</h2>
          <ul className="plain rows">
            {data.recent.map((r, i) => (
              <li key={i}>
                <span>
                  {r.day} {r.trigger && <small className="muted">· {r.trigger}</small>}
                </span>
                <small className="muted">
                  {r.stepsDone}/{r.stepsTotal} steps
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
