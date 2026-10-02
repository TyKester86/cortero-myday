import { useState } from 'react';
import type { BattlesResponse, EarnResult } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useToast } from '../../components/useToast';
import { useConfirm } from '../../components/Confirm';

/** Boss battles: pick one big avoided thing, beat it, earn the XP. */
export default function Battles() {
  const { data, error, setData } = useLoad<BattlesResponse>('/api/battles');
  const [custom, setCustom] = useState('');
  const { toast, show, earned } = useToast();
  const confirm = useConfirm();
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const start = async (name: string): Promise<void> => {
    if (data.active && !(await confirm({ title: `Replace "${data.active.name}"?`, body: 'Your current battle ends without XP.', confirmLabel: 'Replace' }))) return;
    setData(await api<BattlesResponse>('/api/battles', 'POST', { name }));
    show('Battle started ⚔️');
  };
  const complete = async (): Promise<void> => {
    const r = await api<EarnResult & { battles: BattlesResponse }>('/api/battles/complete', 'POST');
    setData(r.battles);
    if (r.leveledUp) earned(r, 0);
    else show(`Boss defeated! +${data.xp} XP`);
  };

  return (
    <section>
      <h1>Boss battles</h1>
      <p className="muted">
        One {data.cadence === 'epic' ? 'epic' : data.cadence} boss at a time. Beat it for +{data.xp} XP.
      </p>
      {data.active ? (
        <div className="card current" data-testid="active-battle">
          <small className="muted">ACTIVE since {data.active.startedOn}</small>
          <h2>{data.active.name}</h2>
          <button className="btn" onClick={() => void complete()}>
            I beat it ✓
          </button>
        </div>
      ) : (
        <p className="muted">No active battle. Pick one:</p>
      )}
      <ul className="plain rows">
        {data.bosses.map((b) => (
          <li key={b.name}>
            <span>
              <b>{b.name}</b>
              <br />
              <small className="muted">{b.desc}</small>
            </span>
            <button className="btn small" onClick={() => void start(b.name)}>
              Fight
            </button>
          </li>
        ))}
      </ul>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void start(custom).then(() => setCustom(''));
        }}
      >
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Or name your own boss" required />
        <button className="btn small">Fight</button>
      </form>
      {data.history.length > 0 && (
        <>
          <h2>History</h2>
          <ul className="plain rows">
            {data.history.map((h) => (
              <li key={h.id}>
                <span>{h.name}</span>
                <small className="muted">{h.status === 'done' ? `beaten ${h.doneOn}` : 'replaced'}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {toast}
    </section>
  );
}
