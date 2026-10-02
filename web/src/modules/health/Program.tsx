import { useState } from 'react';
import { Link } from 'react-router';
import {
  BUILD_INFO,
  BUILDS,
  type BuildKey,
  type ProgramStatus,
  type SetBuildRequest,
  type TrainingLevel,
} from '@myday/shared';
import { api, withMember } from '../../api';

/** Pick a body-style build. Used at signup, on Health, and in Settings. */
export function BuildPicker({
  memberKey,
  current,
  onDone,
  cta = 'Build my year',
}: {
  memberKey: string | null;
  current?: ProgramStatus | null;
  onDone: (p: ProgramStatus | null) => void;
  cta?: string;
}) {
  const [build, setBuild] = useState<BuildKey | null>(current?.build.key ?? null);
  const [level, setLevel] = useState<TrainingLevel>(current?.level ?? 'beginner');
  const [bw, setBw] = useState(current ? String(current.bodyweightLb) : '');
  const [food, setFood] = useState(current ? String(current.shakes.foodProtein) : '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (!build) return;
    setBusy(true);
    setErr(null);
    try {
      const body: SetBuildRequest = { build, level, bodyweightLb: Number(bw), ...(food ? { foodProtein: Number(food) } : {}) };
      const r = await api<{ program: ProgramStatus | null }>(withMember('/api/program', memberKey), 'PUT', body);
      onDone(r.program);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="build-picker">
      {(['men', 'women'] as const).map((g) => (
        <div key={g}>
          <h2>{g === 'men' ? 'Builds for men' : 'Builds for women'}</h2>
          <div className="buildgrid">
            {BUILDS.filter((b) => BUILD_INFO[b].group === g).map((b) => (
              <button key={b} type="button" className={build === b ? 'buildopt on' : 'buildopt'} onClick={() => setBuild(b)} aria-pressed={build === b}>
                <b>{BUILD_INFO[b].label}</b>
                <small>{BUILD_INFO[b].look}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="form" style={{ marginTop: 12 }}>
        <label>
          Bodyweight (lb)
          <input inputMode="numeric" value={bw} onChange={(e) => setBw(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="e.g. 180" />
        </label>
        <label>
          Training experience
          <select value={level} onChange={(e) => setLevel(e.target.value as TrainingLevel)}>
            <option value="beginner">New or coming back (under a year of steady lifting)</option>
            <option value="experienced">Experienced (a year or more)</option>
          </select>
        </label>
        <label>
          Protein from food per day, before shakes (g) — optional
          <input inputMode="numeric" value={food} onChange={(e) => setFood(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder={build ? String(BUILD_INFO[build].foodProteinDefault) : '100'} />
        </label>
        {current && <p className="muted small">Changing your build re-plans your year starting this week.</p>}
        <button className="btn" disabled={!build || !bw || busy} onClick={() => void save()}>
          {cta}
        </button>
        {err && <p className="error">{err}</p>}
      </div>
    </div>
  );
}

/** Phase, week, macros, shakes, and today's protein target vs what's planned. */
export function ProgramCard({ program, onChange }: { program: ProgramStatus; onChange?: () => void }) {
  const p = program;
  const pct = Math.min(100, Math.round((p.plannedProtein / Math.max(1, p.shakes.proteinTarget)) * 100));
  return (
    <div className="card" data-testid="program">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          {p.build.label} · {p.phase.name}
        </h2>
        <span className="pill sun">Week {p.week}</span>
      </div>
      <p className="muted small">{p.phase.focus}</p>
      <p>
        <b>{p.macros.calories}</b> cal · <b>{p.macros.protein}g</b> protein · {p.macros.carbs}g carbs · {p.macros.fat}g fat
      </p>
      <div className="row small">
        <span className="grow">
          Protein today: <b data-testid="protein-planned">{p.plannedProtein}g</b> planned of <b>{p.shakes.proteinTarget}g</b>
        </span>
        <span className="pill">{p.shakes.label}</span>
      </div>
      <div className="bar" style={{ marginTop: 6 }}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {p.cardio && <p className="small muted">Cardio: {p.cardio}</p>}
      <div className="row small" style={{ marginTop: 6 }}>
        <Link to="/health/plan">See all 52 weeks</Link>
        <Link to="/meals?phase=mine">Meals for this phase</Link>
        {onChange && (
          <button className="link" onClick={onChange}>
            Change build
          </button>
        )}
      </div>
    </div>
  );
}
