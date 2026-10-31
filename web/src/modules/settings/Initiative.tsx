/**
 * JP7 + JP1 in Settings: when Hana may start a conversation (named reasons, granted per person,
 * revocable), the last times she did and why — and this device's voice choices.
 */
import { useState } from 'react';
import { INITIATIVE_REASONS, type InitiativeReason, type InitiativeView } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';
import { devicePref, setDevicePref } from '../../components/Presence';

function Grants({ v, editable, onSaved }: { v: InitiativeView; editable: boolean; onSaved: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const toggle = async (r: InitiativeReason, on: boolean): Promise<void> => {
    setErr(null);
    try {
      await api(`/api/hana/initiative/${v.memberId}`, 'PUT', { reasons: on ? [...v.granted, r] : v.granted.filter((x) => x !== r) });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t save');
    }
  };
  return (
    <ul className="plain rows" data-testid={`initiative-${v.memberId}`}>
      {INITIATIVE_REASONS.map((r) => (
        <li key={r.reason}>
          <label className="row">
            <input type="checkbox" checked={v.granted.includes(r.reason)} disabled={!editable} onChange={(e) => void toggle(r.reason, e.target.checked)} aria-label={`${v.member}: ${r.label}`} />
            <span>
              {r.label} <small className="muted">· {r.detail}</small>
            </span>
          </label>
        </li>
      ))}
      {err && <li className="error small">{err}</li>}
    </ul>
  );
}

export function InitiativeCard() {
  const { isAdult } = useSession();
  const { data, reload } = useLoad<{ mine: InitiativeView; kids: InitiativeView[] }>('/api/hana/initiative');
  const [replies, setReplies] = useState(devicePref('replies') === '1');
  const [headsUps, setHeadsUps] = useState(devicePref('headsUps') === '1');
  if (!data) return null;
  return (
    <div className="card" data-testid="initiative-card">
      <h2>When Hana may start a conversation</h2>
      <p className="muted small">
        Only for the reasons ticked here, and not during quiet hours. Everything else waits for your brief. Always on: safety (the alarm going off, a family-emergency scam){isAdult ? '' : ' and telling you when something about you changes'}.
      </p>
      <Grants v={data.mine} editable={isAdult} onSaved={reload} />
      {!isAdult && <p className="muted small">Your grown-ups choose these for you.</p>}
      {data.kids.map((k) => (
        <div key={k.memberId}>
          <h3 className="ing-head">For {k.member}</h3>
          <Grants v={k} editable onSaved={reload} />
        </div>
      ))}
      {data.mine.recent.length > 0 && (
        <>
          <h3 className="ing-head">The last times she did, and why</h3>
          <ul className="plain rows">
            {data.mine.recent.slice(0, 8).map((r) => (
              <li key={r.id} data-testid="initiative-recent">
                <span className="small">
                  <b>{r.title.replace(/^Hana: /, '')}</b> · {r.text} <small className="muted">{new Date(r.at).toLocaleString()}</small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="ing-head">Voice on this device</h3>
      <label className="row small">
        <input
          type="checkbox"
          checked={replies}
          onChange={(e) => {
            setReplies(e.target.checked);
            setDevicePref('replies', e.target.checked ? '1' : null);
          }}
        />{' '}
        Speak Hana’s answers when I talk to her
      </label>
      <label className="row small">
        <input
          type="checkbox"
          checked={headsUps}
          onChange={(e) => {
            setHeadsUps(e.target.checked);
            setDevicePref('headsUps', e.target.checked ? '1' : null);
          }}
          data-testid="speak-headsups"
        />{' '}
        Say her heads-ups out loud on this device while MyDay is open (good for a kitchen tablet)
      </label>
      <p className="muted small">She only listens while you hold the microphone button. Never in the background.</p>
    </div>
  );
}
