/**
 * C4 in Family HQ: open loops — what, who owes it, by when, where it came from. About-to-break
 * first; past-date ones stay and age. A parent closes one (that's the evidence) or reopens it.
 */
import { useState, type FormEvent } from 'react';
import type { HanaLoop } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';

const when = (l: HanaLoop): string =>
  l.breaking === 'past'
    ? `was due ${l.due}, still open (${l.daysPast} day${l.daysPast === 1 ? '' : 's'})`
    : l.breaking === 'today'
      ? 'due today'
      : l.breaking === 'tomorrow'
        ? 'due tomorrow'
        : l.due
          ? `due ${l.due}`
          : 'no date';

export function LoopsCard() {
  const { members } = useSession();
  const [showClosed, setShowClosed] = useState(false);
  const { data, setData, reload } = useLoad<{ loops: HanaLoop[] }>(`/api/hana/loops${showClosed ? '?closed=1' : ''}`);
  const [adding, setAdding] = useState(false);
  const [what, setWhat] = useState('');
  const [owedBy, setOwedBy] = useState('');
  const [due, setDue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!data) return null;
  const put = (l: HanaLoop): void => setData({ loops: data.loops.map((x) => (x.id === l.id ? l : x)) });
  const act = async (l: HanaLoop, verb: 'close' | 'reopen' | 'share'): Promise<void> => {
    try {
      put((await api<{ loop: HanaLoop }>(`/api/hana/loops/${l.id}/${verb}`, 'POST', verb === 'share' ? { shared: l.private } : {})).loop);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t go through');
    }
  };
  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    try {
      await api('/api/hana/loops', 'POST', { what, owedBy: owedBy || 'me', due: due || null });
      setAdding(false);
      setWhat('');
      setDue('');
      reload();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Couldn’t add that');
    }
  };
  const open = data.loops.filter((l) => l.open);
  const closed = data.loops.filter((l) => !l.open);
  return (
    <div className="card" data-testid="hq-loops">
      <h2>Open loops</h2>
      <p className="muted small">Commitments — ours and theirs. One closes only when someone marks it or the reply arrives; past its date it stays here.</p>
      {!open.length && <p className="muted">Nothing open.</p>}
      <ul className="hq-log">
        {open.map((l) => (
          <li key={l.id} className={l.breaking ? `loop ${l.breaking}` : 'loop'} data-testid="hq-loop">
            <span>
              <b>{l.owedByUs ? l.owedBy : `Waiting on ${l.owedBy}`}</b>: {l.what}
            </span>
            <small className="muted">
              {when(l)} · {l.sourceLabel}
              {l.private ? ' · only you' : ''}
            </small>
            <span className="row">
              <button type="button" className="btn small ghost" onClick={() => void act(l, 'close')} data-testid="hq-loop-close">
                Done
              </button>
              {l.source === 'chat' || l.source === 'manual' ? (
                <button type="button" className="btn small ghost" onClick={() => void act(l, 'share')}>
                  {l.private ? 'Share with the family' : 'Make private'}
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {showClosed && closed.length > 0 && (
        <>
          <h3>Closed lately</h3>
          <ul className="hq-log">
            {closed.map((l) => (
              <li key={l.id} data-testid="hq-loop-closed">
                <span>{l.what}</span>
                <small className="muted">{l.evidence}</small>
                <button type="button" className="link small" onClick={() => void act(l, 'reopen')}>
                  Reopen
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {err && <p className="error small">{err}</p>}
      <div className="row">
        <button type="button" className="link small" onClick={() => setShowClosed(!showClosed)}>
          {showClosed ? 'Hide closed' : 'Show closed'}
        </button>
        {!adding && (
          <button type="button" className="btn small" onClick={() => setAdding(true)} data-testid="hq-loop-add">
            + Track something
          </button>
        )}
      </div>
      {adding && (
        <form className="cal-source-form" onSubmit={(e) => void add(e)}>
          <input value={what} onChange={(e) => setWhat(e.target.value)} placeholder="What, e.g. Return the field trip form" required maxLength={200} aria-label="What" />
          <label>
            Who owes it{' '}
            <select value={owedBy} onChange={(e) => setOwedBy(e.target.value)}>
              <option value="">Me</option>
              {members.map((m) => (
                <option key={m.key} value={m.name}>
                  {m.name}
                </option>
              ))}
              <option value="the school">The school</option>
            </select>
          </label>
          <label>
            By <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <span className="row">
            <button type="button" className="btn small ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn small">Track it</button>
          </span>
        </form>
      )}
    </div>
  );
}
