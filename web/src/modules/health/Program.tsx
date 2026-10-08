import { useState } from 'react';
import { Link } from 'react-router';
import {
  ACTIVITY,
  BUILD_INFO,
  BUILDS,
  ED_SCREEN,
  TEEN_STYLE,
  type Activity,
  type BuildKey,
  type LifeStage,
  type ProgramStatus,
  type SetBuildRequest,
  type Sex,
  type TrainingLevel,
  type WeighInSummary,
} from '@myday/shared';
import { api, ApiFail, useLoad, withMember } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { count } from '../../format';

/** What each build trains, in teen mode (a training focus, never a body target). */
const TEEN_FOCUS: Record<BuildKey, string> = {
  lean_athletic: 'Full-body strength with an upper-body focus. 4 days a week.',
  v_taper: 'Shoulders and back focus. 5 days a week.',
  thick_powerful: 'Heavy lifts, lots of practice on the big ones. 5 days a week.',
  strong_dense: 'Low-rep strength on squat, bench, deadlift and press. 4 days a week.',
  toned_athletic: 'Full-body strength. 3 days a week.',
  hourglass: 'Glutes and shoulders focus. 5 days a week.',
  strong_curvy: 'Heavy lower body plus upper-body strength. 4 days a week.',
  lean_runner: 'Running first, plus 2 strength days that make running easier.',
  shredded: '',
};

const SHREDDED_COSTS =
  'Shredded is a peak, not a lifestyle. Getting very lean takes a muscular base first, then a 3–5 month cut — ours is capped at 16 weeks, followed by required maintenance. Near the end, energy, mood, sleep and sex drive commonly dip. After the peak we guide you back to a level you can live at. If food starts to feel like it’s running your life, tap “I need a break” and we’ll pause the cut.';

type Gate =
  | { code: 'shredded_screen'; message: string }
  | { code: 'shredded_ack'; message: string }
  | { code: 'shredded_needs_base' | 'shredded_screen_positive' | 'adults_only'; message: string }
  | { code: 'clinician_needed'; message: string };

/** The in-page modal for the build picker's safety gates. */
function GateModal({ gate, onAnswer, onClose }: { gate: Gate; onAnswer: (extra: Partial<SetBuildRequest> | 'lean_athletic') => void; onClose: () => void }) {
  const [answers, setAnswers] = useState<Array<boolean | null>>(ED_SCREEN.map(() => null));
  const [cleared, setCleared] = useState(false);
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="gate-title" data-testid="build-gate">
        {gate.code === 'shredded_screen' && (
          <>
            <h2 id="gate-title">A few quick questions</h2>
            <p className="muted small">Very lean cuts aren’t safe for everyone. Answer honestly — only you see this.</p>
            {ED_SCREEN.map((q, i) => (
              <div key={q} className="row small" style={{ alignItems: 'center' }}>
                <span className="grow">{q}</span>
                {(['Yes', 'No'] as const).map((label) => (
                  <label key={label} className="habit" style={{ marginLeft: 6 }}>
                    <input
                      type="radio"
                      name={`ed${i}`}
                      checked={answers[i] === (label === 'Yes')}
                      onChange={() => setAnswers(answers.map((a, j) => (j === i ? label === 'Yes' : a)))}
                    />
                    {label}
                  </label>
                ))}
              </div>
            ))}
            <div className="confirm-actions">
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn" disabled={answers.some((a) => a === null)} onClick={() => onAnswer({ edScreen: answers.map((a) => a === true) })}>
                Continue
              </button>
            </div>
          </>
        )}
        {gate.code === 'shredded_ack' && (
          <>
            <h2 id="gate-title">Before you pick Shredded</h2>
            <p>{SHREDDED_COSTS}</p>
            <div className="confirm-actions">
              <button className="btn ghost" onClick={() => onAnswer('lean_athletic')}>
                Lean Athletic instead
              </button>
              <button className="btn" onClick={() => onAnswer({ shreddedAck: true })} data-testid="gate-ok">
                I understand
              </button>
            </div>
          </>
        )}
        {(gate.code === 'shredded_needs_base' || gate.code === 'shredded_screen_positive' || gate.code === 'adults_only') && (
          <>
            <h2 id="gate-title">{gate.code === 'shredded_screen_positive' ? 'Let’s go a different way' : 'Not Shredded — yet'}</h2>
            <p>{gate.message}</p>
            <div className="confirm-actions">
              <button className="btn ghost" onClick={onClose}>
                Back
              </button>
              <button className="btn" onClick={() => onAnswer('lean_athletic')} data-testid="gate-ok">
                Use Lean Athletic
              </button>
            </div>
          </>
        )}
        {gate.code === 'clinician_needed' && (
          <>
            <h2 id="gate-title">Check with your clinician first</h2>
            <p>{gate.message}</p>
            <label className="habit">
              <input type="checkbox" checked={cleared} onChange={(e) => setCleared(e.target.checked)} />
              My clinician has cleared me for exercise, and I’ll follow their limits
            </label>
            <div className="confirm-actions">
              <button className="btn ghost" onClick={onClose}>
                Not yet
              </button>
              <button className="btn" disabled={!cleared} onClick={() => onAnswer({ clinicianCleared: true })} data-testid="gate-ok">
                Continue
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const GATES = ['shredded_screen', 'shredded_ack', 'shredded_needs_base', 'shredded_screen_positive', 'adults_only', 'clinician_needed'];

/** Pick a body-style build. Used at signup, on Health, and in Settings. */
export function BuildPicker({
  memberKey,
  current,
  onDone,
  cta = 'Build my year',
  teen = false,
  age = null,
}: {
  memberKey: string | null;
  current?: ProgramStatus | null;
  onDone: (p: ProgramStatus | null) => void;
  cta?: string;
  /** Under 18: builds are training styles, no weight or food targets. */
  teen?: boolean;
  age?: number | null;
}) {
  const [build, setBuild] = useState<BuildKey | null>(current?.build.key ?? null);
  const [level, setLevel] = useState<TrainingLevel>(current?.level ?? 'beginner');
  const [bw, setBw] = useState(current?.bodyweightLb ? String(current.bodyweightLb) : '');
  const [food, setFood] = useState(current?.shakes ? String(current.shakes.foodProtein) : '');
  const [sex, setSex] = useState<Sex | ''>('');
  const [years, setYears] = useState(age ? String(age) : '');
  const [ft, setFt] = useState('');
  const [inch, setInch] = useState('');
  const [activity, setActivity] = useState<Activity>('moderate');
  const [goal, setGoal] = useState('');
  const [lifeStage, setLifeStage] = useState<LifeStage>(current?.lifeStage ?? 'none');
  const [cutFirst, setCutFirst] = useState<boolean | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [extra, setExtra] = useState<Partial<SetBuildRequest>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sexNow: Sex = sex || (build && BUILD_INFO[build].group === 'men' ? 'male' : 'female');
  const heightIn = ft ? Number(ft) * 12 + (Number(inch) || 0) : null;
  const bmi = heightIn && bw ? (703 * Number(bw)) / (heightIn * heightIn) : null;

  const save = async (more: Partial<SetBuildRequest> = {}, pick: BuildKey | null = build): Promise<void> => {
    if (!pick) return;
    setBusy(true);
    setErr(null);
    const all = { ...extra, ...more };
    try {
      const body: SetBuildRequest = {
        build: pick,
        level,
        ...(bw ? { bodyweightLb: Number(bw) } : {}),
        ...(food ? { foodProtein: Number(food) } : {}),
        ...(sex ? { sex } : {}),
        ...(years ? { ageYears: Number(years) } : {}),
        ...(heightIn ? { heightIn } : {}),
        ...(teen ? {} : { activity, lifeStage }),
        ...(goal ? { goalWeightLb: Number(goal) } : {}),
        ...(cutFirst !== null ? { startWithCut: cutFirst } : {}),
        ...all,
      };
      const r = await api<{ program: ProgramStatus | null }>(withMember('/api/program', memberKey), 'PUT', body);
      setGate(null);
      setExtra({});
      onDone(r.program);
    } catch (e) {
      if (e instanceof ApiFail && e.code && GATES.includes(e.code)) {
        setExtra(all);
        setGate({ code: e.code, message: e.message } as Gate);
      } else {
        setErr(e instanceof Error ? e.message : 'Could not save');
      }
    } finally {
      setBusy(false);
    }
  };

  const answer = (a: Partial<SetBuildRequest> | 'lean_athletic'): void => {
    if (a === 'lean_athletic') {
      setBuild('lean_athletic');
      setExtra({});
      setGate(null);
      void save({ edScreen: undefined, shreddedAck: undefined }, 'lean_athletic');
      return;
    }
    void save(a);
  };

  const groups = teen ? (['all'] as const) : (['men', 'women'] as const);
  return (
    <div data-testid="build-picker">
      {groups.map((g) => (
        <div key={g}>
          <h2>{g === 'all' ? 'Pick a training style' : g === 'men' ? 'Builds for men' : 'Builds for women'}</h2>
          <div className="buildgrid">
            {BUILDS.filter((b) => (g === 'all' ? TEEN_STYLE[b] !== null : BUILD_INFO[b].group === g)).map((b) => (
              <button key={b} type="button" className={build === b ? 'buildopt on' : 'buildopt'} onClick={() => setBuild(b)} aria-pressed={build === b}>
                <b>{teen ? TEEN_STYLE[b] : BUILD_INFO[b].label}</b>
                <small>{teen ? TEEN_FOCUS[b] : BUILD_INFO[b].look}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="form" style={{ marginTop: 12 }}>
        {!teen && (
          <label>
            Bodyweight (lb)
            <input inputMode="numeric" value={bw} onChange={(e) => setBw(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="e.g. 180" />
          </label>
        )}
        <label>
          Age
          <input inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value.replace(/\D/g, '').slice(0, 2))} placeholder="e.g. 34" />
        </label>
        {!teen && (
          <>
            <label>
              Sex (for the calorie estimate)
              <select value={sexNow} onChange={(e) => setSex(e.target.value as Sex)}>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </label>
            <label>
              Height
              <span className="inline">
                <input className="qty" inputMode="numeric" value={ft} onChange={(e) => setFt(e.target.value.replace(/\D/g, '').slice(0, 1))} placeholder="ft" aria-label="Feet" />
                <input className="qty" inputMode="numeric" value={inch} onChange={(e) => setInch(e.target.value.replace(/\D/g, '').slice(0, 2))} placeholder="in" aria-label="Inches" />
              </span>
            </label>
            <label>
              A typical week
              <select value={activity} onChange={(e) => setActivity(e.target.value as Activity)}>
                {(Object.keys(ACTIVITY) as Activity[]).map((a) => (
                  <option key={a} value={a}>
                    {ACTIVITY[a].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Goal weight (lb) — optional
              <input inputMode="numeric" value={goal} onChange={(e) => setGoal(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="leave blank if you’re not sure" />
            </label>
            {sexNow === 'female' && (
              <label>
                Pregnant, or had a baby in the last year?
                <select value={lifeStage} onChange={(e) => setLifeStage(e.target.value as LifeStage)} data-testid="life-stage">
                  <option value="none">No</option>
                  <option value="pregnant">I’m pregnant</option>
                  <option value="postpartum">I had a baby in the last 12 months</option>
                </select>
              </label>
            )}
          </>
        )}
        <label>
          Training experience
          <select value={level} onChange={(e) => setLevel(e.target.value as TrainingLevel)}>
            <option value="beginner">New or coming back (under a year of steady lifting)</option>
            <option value="experienced">Experienced (a year or more)</option>
          </select>
        </label>
        {!teen && (
          <>
            <label>
              Protein from food per day, before shakes (g) — optional
              <input inputMode="numeric" value={food} onChange={(e) => setFood(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder={build ? String(BUILD_INFO[build].foodProteinDefault) : '100'} />
            </label>
            {build && !['shredded', 'lean_runner'].includes(build) && (
              <label className="habit">
                <input type="checkbox" checked={cutFirst ?? (bmi !== null && bmi >= 30)} onChange={(e) => setCutFirst(e.target.checked)} />
                Start the year with fat loss{bmi !== null && bmi >= 30 ? ' (suggested for you)' : ''}
              </label>
            )}
          </>
        )}
        {current && <p className="muted small">Changing your build re-plans your year starting this week.</p>}
        <button className="btn" disabled={!build || (!teen && !bw) || busy} onClick={() => void save()}>
          {cta}
        </button>
        {err && <p className="error">{err}</p>}
      </div>
      {gate && <GateModal gate={gate} onAnswer={answer} onClose={() => setGate(null)} />}
    </div>
  );
}

/** The 4-weekly check-in (women cutting, Lean Runner, Shredded). */
function Checkin({ program, memberKey, onDone }: { program: ProgramStatus; memberKey: string; onDone: (p: ProgramStatus) => void }) {
  const [a, setA] = useState<Record<string, boolean>>({});
  const [months, setMonths] = useState('');
  const [busy, setBusy] = useState(false);
  const q = (key: string, text: string) => (
    <label key={key} className="habit">
      <input type="checkbox" checked={!!a[key]} onChange={(e) => setA({ ...a, [key]: e.target.checked })} />
      {text}
    </label>
  );
  const send = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api<{ program: ProgramStatus }>(withMember('/api/program/checkin', memberKey), 'POST', { ...a, monthsNoPeriod: months ? Number(months) : 0 });
      onDone(r.program);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" data-testid="checkin">
      <h2>Your 4-week check-in</h2>
      <p className="muted small">Tick anything that’s true for the last 4 weeks. It keeps the plan safe for you.</p>
      {program.checkin.askPeriods && (
        <>
          {q('periodChange', 'My period has changed or stopped (hormonal birth control can hide changes)')}
          {a.periodChange && (
            <label className="small">
              Months since your last period
              <input className="qty" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value.replace(/\D/g, '').slice(0, 2))} aria-label="Months since last period" />
            </label>
          )}
        </>
      )}
      {q('boneInjury', 'A stress fracture or bone-stress injury')}
      {q('fatigue', 'Unusually tired, or sick more often than usual')}
      {q('foodWorry', 'Food or weight feels like it’s running my life')}
      {q('sleepPoor', 'Sleeping badly')}
      {q('aches', 'Joints or tendons aching')}
      <button className="btn small" disabled={busy} onClick={() => void send()}>
        Save check-in
      </button>
    </div>
  );
}

/** Opt-in weigh-ins, shown only as a 7-day average. */
function WeighIns({ memberKey, enabled }: { memberKey: string; enabled: boolean }) {
  const { data, setData } = useLoad<WeighInSummary>(enabled ? withMember('/api/weigh-ins', memberKey) : null);
  const [w, setW] = useState('');
  const toggle = async (on: boolean): Promise<void> => {
    setData(await api<WeighInSummary>(withMember('/api/weigh-ins', memberKey), 'PUT', { enabled: on }));
  };
  const on = data?.enabled ?? enabled;
  if (!on) {
    return (
      <button className="link small" onClick={() => void toggle(true)} data-testid="weighins-on">
        Track my weight (optional — shown only as a 7-day average)
      </button>
    );
  }
  return (
    <div className="small" data-testid="weighins">
      <span className="inline">
        <input className="qty" inputMode="numeric" value={w} onChange={(e) => setW(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="lb" aria-label="Today’s weight" />
        <button
          className="btn small"
          disabled={!w}
          onClick={() =>
            void api<WeighInSummary>(withMember('/api/weigh-ins', memberKey), 'POST', { weightLb: Number(w) }).then((r) => {
              setData(r);
              setW('');
            })
          }
        >
          Log weight
        </button>
        {data?.average7 !== null && data?.average7 !== undefined && (
          <span>
            7-day average: <b data-testid="weigh-avg">{data.average7} lb</b>
          </span>
        )}
        <button className="link" onClick={() => void toggle(false)}>
          Stop tracking
        </button>
      </span>
      <p className="muted">Daily numbers bounce with water and salt, so we only ever show the weekly average. We use it to fine-tune your calories every 2 weeks.</p>
    </div>
  );
}

/** Phase, week, food targets, shakes, check-ins and the safety controls. */
export function ProgramCard({ program, onChange, memberKey, onUpdate }: { program: ProgramStatus; onChange?: () => void; memberKey?: string; onUpdate?: (p: ProgramStatus) => void }) {
  const p = program;
  const confirm = useConfirm();
  const call = async (path: string, body: unknown): Promise<void> => {
    if (!memberKey) return;
    const r = await api<{ program: ProgramStatus }>(withMember(path, memberKey), 'POST', body);
    onUpdate?.(r.program);
  };
  const resume = async (): Promise<void> => {
    if (!(await confirm({ title: 'Has a clinician cleared you to resume the cut?', body: 'Only resume after a doctor has checked the reason it was paused.', confirmLabel: 'Yes, I’m cleared' }))) return;
    await call('/api/program/resume', { clinicianCleared: true });
  };
  const cutting = p.phase.nutrition === 'cutting';
  const pct = p.shakes && p.plannedProtein !== null ? Math.min(100, Math.round((p.plannedProtein / Math.max(1, p.shakes.proteinTarget)) * 100)) : 0;
  return (
    <div className="card" data-testid="program">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          {p.label} · {p.phase.name}
        </h2>
        <span className="pill sun">Week {p.week}</span>
      </div>
      <p className="muted small">
        Chapter {p.chapter} of 4 · {p.phase.focus}
      </p>
      {p.cutPaused && (
        <div className="card warn" data-testid="cut-paused">
          <b>Your cut is paused.</b> {p.cutPaused}{' '}
          {memberKey && (
            <button className="link" onClick={() => void resume()}>
              A clinician cleared me — resume
            </button>
          )}
        </div>
      )}
      {p.dietBreakUntil && (
        <p className="small" data-testid="diet-break">
          Diet break: eating at maintenance until {p.dietBreakUntil}.{' '}
          {memberKey && (
            <button className="link" onClick={() => void call('/api/program/diet-break', { on: false })}>
              End it early
            </button>
          )}
        </p>
      )}
      {p.macros && p.energy ? (
        <>
          <p data-testid="macros">
            <b>{p.macros.calories}</b> cal · <b>{p.macros.protein}g</b> protein · {p.macros.carbs}g carbs · {p.macros.fat}g fat
          </p>
          <p className="muted small">
            Maintenance ≈ {p.energy.maintenance} cal{p.energy.adjust ? ` (fine-tuned ${p.energy.adjust > 0 ? '+' : ''}${p.energy.adjust} from your weigh-ins)` : ''}
            {p.energy.capped && ' · deficit capped at a safe 500 cal/day'}
            {p.energy.floored && ' · raised to the safe minimum'}
            {p.perMeal && ` · about ${p.perMeal.grams}g protein per meal across ${count(p.perMeal.meals, 'meal')}`}
          </p>
        </>
      ) : (
        <p className="small" data-testid="no-targets">
          {p.teen
            ? 'No calorie targets in teen mode — eat regular meals with a protein food at each one, and plenty of fuel on training days.'
            : 'Your clinician sets your food targets right now. Eat regular meals with a protein food at each one.'}
        </p>
      )}
      {p.shakes && p.plannedProtein !== null && (
        <>
          <div className="row small">
            <span className="grow">
              Protein today: <b data-testid="protein-planned">{p.plannedProtein}g</b> planned of <b>{p.shakes.proteinTarget}g</b>
            </span>
            <span className="pill">{p.shakes.label}</span>
          </div>
          <div className="bar" style={{ marginTop: 6 }}>
            <i style={{ width: `${pct}%` }} />
          </div>
        </>
      )}
      {p.cardio && <p className="small muted">Cardio: {p.cardio}</p>}
      {p.deloadSuggested && !p.deloadThisWeek && (
        <p className="small" data-testid="deload-suggested">
          {p.deloadSuggested}{' '}
          {memberKey && (
            <button className="link" onClick={() => void call('/api/program/deload', { on: true })}>
              Make this a deload week
            </button>
          )}
        </p>
      )}
      {memberKey && (
        <div className="row small" style={{ marginTop: 6 }}>
          <button className="link" onClick={() => void call('/api/program/deload', { on: !p.deloadThisWeek })} data-testid="deload-toggle">
            {p.deloadThisWeek ? 'Undo the deload week' : 'Take a deload week'}
          </button>
          {cutting && !p.cutPaused && !p.dietBreakUntil && !p.teen && (
            <button className="link" onClick={() => void call('/api/program/diet-break', { on: true })} data-testid="diet-break-on">
              {p.build.key === 'shredded' ? 'I need a break' : 'Take a diet break'}
            </button>
          )}
        </div>
      )}
      {memberKey && !p.teen && <WeighIns memberKey={memberKey} enabled={p.weighIns} />}
      {p.notes.length > 0 && (
        <details className="small" style={{ marginTop: 6 }}>
          <summary>Good to know</summary>
          <ul className="plain">
            {p.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="row small" style={{ marginTop: 6 }}>
        <Link to="/health/plan">See all 52 weeks</Link>
        {!p.teen && <Link to="/meals?phase=mine">Meals for this phase</Link>}
        {onChange && (
          <button className="link" onClick={onChange}>
            Change build
          </button>
        )}
      </div>
      {memberKey && p.checkin.due && <Checkin program={p} memberKey={memberKey} onDone={(np) => onUpdate?.(np)} />}
    </div>
  );
}
