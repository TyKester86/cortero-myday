import { useState } from 'react';
import { MODULE_INFO, MODULE_KEYS, type HouseholdInfo, type ModuleKey } from '@myday/shared';
import { api } from '../../api';

/** Settings → What's in your MyDay: turn optional parts on or off for the whole household. */
export function Modules({ hh }: { hh: HouseholdInfo }) {
  const [off, setOff] = useState<Set<ModuleKey>>(new Set(hh.modulesOff));
  const [busy, setBusy] = useState(false);
  const changed = MODULE_KEYS.some((k) => off.has(k) !== hh.modulesOff.includes(k));
  const flip = (k: ModuleKey): void => {
    const next = new Set(off);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setOff(next);
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    await api<HouseholdInfo>('/api/household/info', 'PATCH', { modulesOff: [...off] });
    // The menus are built from the household's choices: reload to show the new set.
    window.location.reload();
  };
  return (
    <div className="card" data-testid="modules">
      <h2>What’s in your MyDay</h2>
      <p className="small muted">Turn off what your household doesn’t use — menus get shorter. Nothing is deleted; turn it back on any time.</p>
      <ul className="plain">
        {MODULE_KEYS.map((k) => (
          <li key={k}>
            <label className="inline-label">
              <input type="checkbox" checked={!off.has(k)} onChange={() => flip(k)} data-testid={`module-${k}`} />
              <b>{MODULE_INFO[k].label}</b> <small className="muted">· {MODULE_INFO[k].about}</small>
            </label>
          </li>
        ))}
      </ul>
      {!hh.hasKids && <p className="small muted">Kid features (homework, rewards, kid money) appear when you add a kid on the Household page.</p>}
      <button className="btn small" disabled={!changed || busy} onClick={() => void save()}>
        Save
      </button>
    </div>
  );
}
