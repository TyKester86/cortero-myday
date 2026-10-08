import { useState } from 'react';
import type { EngagementResponse, Quest } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';
import { day } from '../../dates';
import { count } from '../../format';

/** Rotating weekly quests (kids). Claiming pays points. */
export function QuestsCard({ quests, onClaim }: { quests: Quest[]; onClaim: (q: Quest) => void }) {
  if (!quests.length) return null;
  return (
    <div className="card" data-testid="quests">
      <h2>This week's quests</h2>
      {quests.map((q) => (
        <div key={q.id} className={q.done ? 'quest done' : 'quest'}>
          <span className="grow">
            <b>{q.title}</b> <small className="muted">+{q.reward} pts</small>
            <div className="bar">
              <i style={{ width: `${Math.round((q.progress / q.goal) * 100)}%` }} />
            </div>
            <small className="muted">
              {q.progress}/{q.goal}
            </small>
          </span>
          {q.claimed ? (
            <span className="pill good">Claimed ✓</span>
          ) : (
            <button className="btn small" disabled={!q.done} onClick={() => onClaim(q)}>
              Claim
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function useEngagement(): {
  data: EngagementResponse | null;
  claim: (q: Quest) => Promise<string>;
  setData: (d: EngagementResponse) => void;
} {
  const { data, setData } = useLoad<EngagementResponse>('/api/engagement');
  const claim = async (q: Quest): Promise<string> => {
    try {
      setData(await api<EngagementResponse>(`/api/quests/${q.id}/claim`, 'POST'));
      return `Quest complete! +${count(q.reward, 'point')} 🎉`;
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not claim';
    }
  };
  return { data, claim, setData };
}

/** Family wins: the shared challenge, a celebration-only feed, and the Sunday ritual. */
export default function Wins() {
  const { isAdult } = useSession();
  const { data, claim, setData } = useEngagement();
  const [highlight, setHighlight] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <p className="muted">Loading…</p>;
  const sunday = data.sunday;
  return (
    <section>
      <h1>Family wins</h1>
      {msg && <p className="muted" role="status">{msg}</p>}
      <QuestsCard quests={data.quests} onClaim={(q) => void claim(q).then(setMsg)} />
      {data.challenge && (
        <div className="card" data-testid="family-challenge">
          <h2>{data.challenge.title}</h2>
          <div className="bar">
            <i style={{ width: `${Math.round((data.challenge.progress / data.challenge.goal) * 100)}%` }} />
          </div>
          <p className="small">
            {data.challenge.progress}/{data.challenge.goal}
            {data.challenge.done ? ' — you did it together! 🎉' : ''}
          </p>
          {data.challenge.helpers.length > 0 && <p className="muted small">Chipping in: {data.challenge.helpers.join(', ')}</p>}
        </div>
      )}
      {sunday && (sunday.isSunday || sunday.done) && (
        <div className="card now" data-testid="sunday">
          <small>SUNDAY RITUAL</small>
          <p>Look back at the week together. Everyone names one thing that went well.</p>
          {sunday.weekPoints.length > 0 && (
            <ul className="plain small">
              {sunday.weekPoints.map((p) => (
                <li key={p.name}>
                  {`${p.name}: ${count(p.points, 'point')} this week`}
                </li>
              ))}
            </ul>
          )}
          {sunday.done ? (
            <p>
              ✓ Done{sunday.highlight && <> — highlight: <b>{sunday.highlight}</b></>}
            </p>
          ) : isAdult ? (
            <form
              className="inline"
              onSubmit={(e) => {
                e.preventDefault();
                void api<EngagementResponse>('/api/sunday', 'POST', { highlight })
                  .then((d) => {
                    setData(d);
                    setMsg('Sunday done — have a good week ✓');
                  })
                  .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not save'));
              }}
            >
              <input value={highlight} onChange={(e) => setHighlight(e.target.value)} placeholder="The week's highlight" maxLength={200} />
              <button className="btn small">We did it</button>
            </form>
          ) : null}
        </div>
      )}
      <div className="card" data-testid="win-feed">
        <h2>This week's wins</h2>
        {data.wins.length === 0 && <p className="muted">Wins show up here as they happen.</p>}
        {data.wins.map((w, i) => (
          <div key={i} className="win">
            <span className="emoji">{w.emoji}</span>
            <span>
              <b>{w.who}</b> {w.text}
              <br />
              <small className="muted">{day(w.at)}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
