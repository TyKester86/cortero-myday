/**
 * Q10 in Family HQ: Tier 3 standing authority. Each class shows this family's own record with it;
 * it can be granted only once that record has earned it, and either parent revokes it at once.
 * Moving or spending money is never one of them.
 */
import { useState } from 'react';
import type { StandingClassView } from '@myday/shared';
import { api, useLoad } from '../../api';

export function StandingCard() {
  const { data, setData } = useLoad<{ classes: StandingClassView[] }>('/api/hana/standing');
  const [err, setErr] = useState<string | null>(null);
  if (!data) return null;
  const act = async (c: StandingClassView, verb: 'grant' | 'revoke'): Promise<void> => {
    setErr(null);
    try {
      setData(await api<{ classes: StandingClassView[] }>(`/api/hana/standing/${c.key}/${verb}`, 'POST'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t go through');
    }
  };
  return (
    <div className="card standing" data-testid="hq-standing">
      <h2>Standing OKs</h2>
      <p className="muted small">
        Small, named jobs Hana may do without asking each time — once your family’s own record with her shows she gets them right. Revoke any one at once; every use is in the log and your
        monthly report. Moving or spending money always takes your OK that time.
      </p>
      <ul className="plain rows">
        {data.classes.map((c) => (
          <li key={c.key} data-testid={`standing-${c.key}`}>
            <div className="grow">
              <b>{c.label}</b> <small className="muted">· {c.detail}</small>
              <p className="small">
                {c.granted
                  ? `On — granted by ${c.granted.by ?? 'a grown-up'} ${new Date(c.granted.at).toLocaleDateString()}. Used ${c.used} time${c.used === 1 ? '' : 's'}.`
                  : c.record.eligible
                    ? `Earned: ${c.record.approvedAsIs} approved as she drafted them, no recent failures.`
                    : `Not yet earned — needs ${c.record.missing.join('; ')}. (So far: ${c.record.approvedAsIs} approved as drafted, ${c.record.edited} edited, ${c.record.discarded} discarded.)`}
              </p>
            </div>
            {c.granted ? (
              <button className="btn small danger" onClick={() => void act(c, 'revoke')} data-testid="standing-revoke">
                Revoke
              </button>
            ) : (
              <button className="btn small" disabled={!c.record.eligible} onClick={() => void act(c, 'grant')} data-testid="standing-grant">
                Grant
              </button>
            )}
          </li>
        ))}
      </ul>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}
