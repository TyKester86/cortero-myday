import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { count } from '../../format';

const PRESETS = [10, 15, 20, 25];

/** Kid focus timer: pick a length, one ring fills, a small celebration at the end (counts toward quests). */
export default function Focus() {
  const [minutes, setMinutes] = useState(15);
  const [left, setLeft] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const endAt = useRef(0);

  useEffect(() => {
    if (left === null || left <= 0) return;
    const t = window.setInterval(() => {
      const s = Math.max(0, Math.round((endAt.current - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) {
        window.clearInterval(t);
        setDone(true);
        void api('/api/focus/done', 'POST', { minutes }).catch(() => undefined);
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [left === null, minutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (): void => {
    endAt.current = Date.now() + minutes * 60_000;
    setDone(false);
    setLeft(minutes * 60);
  };
  const total = minutes * 60;
  const pct = left === null ? 0 : Math.round(((total - left) / total) * 100);
  const mm = String(Math.floor((left ?? total) / 60)).padStart(2, '0');
  const ss = String((left ?? total) % 60).padStart(2, '0');

  return (
    <section className="focus">
      <h1>Focus time</h1>
      {left === null && (
        <div className="chips" style={{ justifyContent: 'center' }}>
          {PRESETS.map((m) => (
            <button key={m} className={m === minutes ? 'chip on' : 'chip'} onClick={() => setMinutes(m)}>
              {m} min
            </button>
          ))}
        </div>
      )}
      <div className="ringwrap" style={{ ['--p' as string]: `${pct}%` }}>
        <div>
          <div className="clock" data-testid="focus-clock">
            {mm}:{ss}
          </div>
        </div>
      </div>
      {left === null || done ? (
        <button className="btn" onClick={start}>
          {done ? 'Go again' : 'Start'}
        </button>
      ) : (
        <button className="btn ghost" onClick={() => setLeft(null)}>
          Stop
        </button>
      )}
      {done && (
        <div className="overlay" onClick={() => setDone(false)}>
          <div className="celebrate">
            <div className="big">FOCUS COMPLETE</div>
            <p>{count(minutes, 'minute')} of real focus. That's a win.</p>
            <button className="btn" onClick={() => setDone(false)}>
              Nice
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
