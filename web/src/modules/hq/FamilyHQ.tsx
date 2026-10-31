import { useState } from 'react';
import { CRISIS_RESOURCES, type HanaAction, type HanaAlert, type HanaFamilyReport, type HanaSettings, type HanaWatchCategory } from '@myday/shared';
import { api, useLoad } from '../../api';
import { HanaFace } from '../../components/NavIcon';
import { HanaBriefCard } from './HanaBrief';
import { CoachCard } from './Coach';
import { useSession } from '../../session';
import { HanaLog, HqDraft } from './Notes';
import { LoopsCard } from './Loops';

const thisMonth = (): string => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
};

/** Crisis first, then anything Hana is watching that still needs someone. */
function Alerts() {
  const { data, setData } = useLoad<{ alerts: HanaAlert[] }>('/api/hana/alerts');
  const [drafts, setDrafts] = useState<Record<number, HanaAction>>({});
  const [sent, setSent] = useState<Record<number, string>>({});
  const [err, setErr] = useState<Record<number, string>>({});
  if (!data || !data.alerts.length) return null;
  const done = async (id: number): Promise<void> => {
    await api(`/api/hana/items/${id}/outcome`, 'POST', { outcome: 'acted' });
    setData({ alerts: data.alerts.filter((a) => a.id !== id) });
  };
  const prepare = async (id: number): Promise<void> => {
    try {
      const r = await api<{ action: HanaAction }>(`/api/hana/alerts/${id}/draft`, 'POST');
      setDrafts({ ...drafts, [id]: r.action });
    } catch (e) {
      setErr({ ...err, [id]: e instanceof Error ? e.message : 'Couldn’t prepare a note' });
    }
  };
  return (
    <div className="hq-alerts" data-testid="hq-alerts">
      {data.alerts.map((a) => (
        <div key={a.id} className={`card hq-alert ${a.kind}`} role={a.kind === 'crisis' ? 'alert' : undefined} data-testid={`hq-alert-${a.kind}`}>
          <p>{a.text}</p>
          {a.kind === 'crisis' && (
            <ul className="crisis-resources">
              {CRISIS_RESOURCES.map((r) => (
                <li key={r.href}>
                  <a href={r.href}>{r.label}</a>
                </li>
              ))}
            </ul>
          )}
          <small className="muted">
            {a.source}
            {a.asOf ? ` · ${new Date(a.asOf).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
          </small>
          {drafts[a.id] && !sent[a.id] && (
            <HqDraft
              action={drafts[a.id] as HanaAction}
              onDone={(r) => setSent({ ...sent, [a.id]: r.status === 'done' ? r.result : 'Discarded — nothing was sent.' })}
            />
          )}
          {sent[a.id] && <p className="small muted" data-testid="hq-draft-result">{sent[a.id]}</p>}
          {err[a.id] && <p className="error small">{err[a.id]}</p>}
          <div className="row">
            {a.kind === 'escalation' && !drafts[a.id] && (
              <button type="button" className="btn small ghost" onClick={() => void prepare(a.id)} data-testid="hq-prepare-note">
                Prepare a note
              </button>
            )}
            <button type="button" className="btn small" onClick={() => void done(a.id)}>
              {a.kind === 'crisis' ? 'I’ve checked in' : 'Handled'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The monthly family report: parents only, and Hana's mistakes sit right next to her wins. */
function Report() {
  const [month, setMonth] = useState(thisMonth());
  const { data } = useLoad<HanaFamilyReport>(`/api/hana/report?month=${month}`);
  return (
    <div className="card" data-testid="hq-report">
      <h2>Family report</h2>
      <label>
        Month <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </label>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <dl className="hq-needle">
            <dt>Homework on time</dt>
            <dd>{data.homework.rate === null ? 'Nothing was due yet' : `${data.homework.rate}% (${data.homework.onTime} of ${data.homework.due})`}</dd>
            <dt>Missed logistics</dt>
            <dd>
              {data.logistics.missed} ({data.logistics.unownedPickups} pickup{data.logistics.unownedPickups === 1 ? '' : 's'} nobody took, {data.logistics.watchUnhandled} alert
              {data.logistics.watchUnhandled === 1 ? '' : 's'} not handled)
            </dd>
            <dt>Brief items acted on</dt>
            <dd>{data.briefs.rate === null ? 'No briefs yet' : `${data.briefs.rate}% (${data.briefs.acted} of ${data.briefs.shown})`}</dd>
            <dt>Nudges set aside</dt>
            <dd>{data.nudges.shown ? `${data.nudges.dismissed} of ${data.nudges.shown}` : 'None yet'}</dd>
          </dl>
          {data.wins.length > 0 && (
            <>
              <h3>What went well</h3>
              <ul>
                {data.wins.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </>
          )}
          <h3>Where Hana was wrong</h3>
          {data.wrong.length ? (
            <ul data-testid="hq-wrong">
              {data.wrong.map((w, i) => (
                <li key={i}>
                  {w.date}: {w.text} <small className="muted">({w.source})</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing marked wrong this month. Tap “That’s wrong” on anything she gets wrong — it shows up here.</p>
          )}
          <h3>Open loops</h3>
          <p data-testid="hq-loop-ledger">
            {data.loops.opened} opened · {data.loops.closedOnTime} closed on time · {data.loops.broken.length} broken
          </p>
          {data.loops.broken.length > 0 && (
            <ul>
              {data.loops.broken.map((b, i) => (
                <li key={i}>
                  {b.what} (due {b.due}) — {b.cost}
                </li>
              ))}
            </ul>
          )}
          <h3>What Hana couldn’t do</h3>
          {data.gaps.length ? (
            <ul data-testid="hq-gaps">
              {data.gaps.map((g, i) => (
                <li key={i}>
                  {g.date}: {g.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing this month.</p>
          )}
          {data.money && (
            <>
              <h3>{data.month.endsWith('-12') ? 'The annual money physical' : 'Money check-up'}</h3>
              <p data-testid="hq-money">
                Net position {data.money.net.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} — {data.money.trajectory}
              </p>
              {data.money.moves.length > 0 && (
                <ol>
                  {data.money.moves.map((m) => (
                    <li key={m.text}>{m.text}</li>
                  ))}
                </ol>
              )}
            </>
          )}
          {data.tasteMisses.length > 0 && (
            <>
              <h3>Suggestions that missed</h3>
              <ul data-testid="hq-taste">
                {data.tasteMisses.map((t, i) => (
                  <li key={i}>
                    {t.date}: {t.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

const NIGHTS = [
  [7, 'Sun'],
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
] as const;
const CATEGORY_LABEL: Record<HanaWatchCategory, string> = { pickup: 'Pickups nobody is on', conflict: 'Schedule conflicts', bills: 'Bills while money is low', homework: 'Homework at risk', loops: 'Loops due today', expiry: 'Papers expiring', money: 'Money (dips, limits, checks)' };

/** Either parent can tune her down, change the thresholds, or quiet her. */
function HanaSettingsCard() {
  const { data, setData } = useLoad<HanaSettings>('/api/hana/settings');
  const [draft, setDraft] = useState<HanaSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return null;
  const f = draft ?? data;
  const save = async (body: Partial<HanaSettings> & { pauseHours?: number }): Promise<void> => {
    try {
      const r = await api<HanaSettings>('/api/hana/settings', 'PUT', body);
      setData(r);
      setDraft(null);
      setMsg('Saved ✓');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const paused = !!data.pausedUntil && Date.parse(data.pausedUntil) > Date.now();
  return (
    <div className="card" data-testid="hq-settings">
      <h2>What Hana watches</h2>
      <p className="muted small">She only reads and points things out — she never sends, spends or commits anything. Quiet hours hold everything except a same-day problem, like a pickup today with nobody on it.</p>
      <fieldset className="chips">
        <legend>Tell me about</legend>
        {(Object.keys(CATEGORY_LABEL) as HanaWatchCategory[]).map((c) => (
          <label key={c} className="inline-label">
            <input type="checkbox" checked={!f.muted.includes(c)} onChange={(e) => setDraft({ ...f, muted: e.target.checked ? f.muted.filter((x) => x !== c) : [...f.muted, c] })} data-testid={`hq-watch-${c}`} />{' '}
            {CATEGORY_LABEL[c]}
          </label>
        ))}
      </fieldset>
      <div className="row">
        <label>
          Quiet from <input type="time" value={f.quietStart} onChange={(e) => setDraft({ ...f, quietStart: e.target.value })} />
        </label>
        <label>
          until <input type="time" value={f.quietEnd} onChange={(e) => setDraft({ ...f, quietEnd: e.target.value })} />
        </label>
      </div>
      <div className="chips" role="group" aria-label="Quiet nights">
        {NIGHTS.map(([n, label]) => (
          <button key={n} type="button" className={f.quietDays.includes(n) ? 'chip on' : 'chip'} aria-pressed={f.quietDays.includes(n)} onClick={() => setDraft({ ...f, quietDays: f.quietDays.includes(n) ? f.quietDays.filter((x) => x !== n) : [...f.quietDays, n] })}>
            {label} night
          </button>
        ))}
      </div>
      <div className="row">
        <label>
          Low balance under $<input type="number" min={0} step={10} value={f.lowBalance} onChange={(e) => setDraft({ ...f, lowBalance: Number(e.target.value) })} data-testid="hq-low-balance" />
        </label>
        <label>
          Bills count as coming up{' '}
          <select value={f.billLeadDays} onChange={(e) => setDraft({ ...f, billLeadDays: Number(e.target.value) })}>
            {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'on the day' : `${n} day${n === 1 ? '' : 's'} ahead`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <label>
          Time to get between two places{' '}
          <input type="number" min={0} max={120} step={5} value={f.travelMinutes} onChange={(e) => setDraft({ ...f, travelMinutes: Number(e.target.value) })} data-testid="hq-travel" /> min
        </label>
        <label>
          A kid’s day is full past{' '}
          <input type="number" min={2} max={12} value={f.kidDayLimit} onChange={(e) => setDraft({ ...f, kidDayLimit: Number(e.target.value) })} data-testid="hq-kid-day" /> things
        </label>
      </div>
      <fieldset className="row">
        <legend className="small">Notes you send the kids can be</legend>
        {(['encouragement', 'reminder'] as const).map((k) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={f.kidNoteKinds.includes(k)}
              onChange={(e) => setDraft({ ...f, kidNoteKinds: e.target.checked ? [...f.kidNoteKinds, k] : f.kidNoteKinds.filter((x) => x !== k) })}
              data-testid={`hq-kid-note-${k}`}
            />{' '}
            {k === 'encouragement' ? 'Encouragement' : 'Reminders'}
          </label>
        ))}
      </fieldset>
      <div className="row">
        {draft && (
          <button type="button" className="btn small" onClick={() => void save({ quietStart: f.quietStart, quietEnd: f.quietEnd, quietDays: f.quietDays, muted: f.muted, lowBalance: f.lowBalance, billLeadDays: f.billLeadDays, kidNoteKinds: f.kidNoteKinds, travelMinutes: f.travelMinutes, kidDayLimit: f.kidDayLimit })} data-testid="hq-settings-save">
            Save
          </button>
        )}
        <button type="button" className="btn small ghost" onClick={() => void save({ pauseHours: paused ? 0 : 24 })} data-testid="hq-quiet">
          {paused ? 'Let Hana speak up again' : 'Quiet Hana for a day'}
        </button>
      </div>
      {paused && <p className="small muted">Quiet until {new Date(data.pausedUntil as string).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.</p>}
      {msg && <p className="small muted">{msg}</p>}
    </div>
  );
}

/** Family HQ (parents): Hana's view of the whole household. She prepares; a parent approves — nothing goes on its own. */
export default function FamilyHQ() {
  const { members } = useSession();
  const kids = members.filter((m) => m.kind === 'kid');
  return (
    <section data-testid="family-hq">
      <h1 className="hq-title">
        <HanaFace size={32} /> Family HQ
      </h1>
      <p className="muted">Hana’s look at the whole family: today, what’s coming, and anything that needs someone.</p>
      <Alerts />
      <HanaBriefCard />
      {kids.length > 0 && (
        <div data-testid="hq-plans">
          <h2>Homework plans</h2>
          {kids.map((k) => (
            <CoachCard key={k.key} memberKey={k.key} />
          ))}
        </div>
      )}
      <LoopsCard />
      <HanaLog />
      <HanaSettingsCard />
      <Report />
    </section>
  );
}
