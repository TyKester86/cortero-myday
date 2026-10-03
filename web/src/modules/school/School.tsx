import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { WEEKDAYS, type ClassInfo, type EarnResult, type SchoolResponse, type Weekday } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { useSession } from '../../session';
import { due } from '../../dates';

type WithEarn = EarnResult & { school: SchoolResponse };

function ClassForm({ onSave }: { onSave: (b: { name: string; teacher: string; room: string; days: Weekday[]; startTime: string }) => Promise<void> }) {
  const [name, setName] = useState('');
  const [teacher, setTeacher] = useState('');
  const [room, setRoom] = useState('');
  const [days, setDays] = useState<Weekday[]>([]);
  const [startTime, setStart] = useState('');
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void onSave({ name, teacher, room, days, startTime }).then(() => {
      setName('');
      setTeacher('');
      setRoom('');
      setDays([]);
      setStart('');
    });
  };
  return (
    <form className="form" onSubmit={submit} data-testid="class-form">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Class name (e.g. Biology)" required maxLength={60} />
      <div className="form wide">
        <input value={teacher} onChange={(e) => setTeacher(e.target.value)} placeholder="Teacher" maxLength={60} />
        <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Room" maxLength={40} />
        <input type="time" value={startTime} onChange={(e) => setStart(e.target.value)} aria-label="Start time" />
      </div>
      <div className="days">
        {WEEKDAYS.slice(0, 5).map((d) => (
          <button type="button" key={d} className={days.includes(d) ? 'chip on' : 'chip'} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>
            {d}
          </button>
        ))}
      </div>
      <button className="btn small">Add class</button>
    </form>
  );
}

function ClassRow({ c, onArchive }: { c: ClassInfo; onArchive: () => void }) {
  return (
    <li>
      <span className="grow">
        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: c.color, marginRight: 6 }} />
        <Link to={`/study/${c.id}`}>
          <b>{c.name}</b>
        </Link>{' '}
        <small className="muted">
          {[c.teacher, c.room, c.days.join(' '), c.startTime, c.source === 'classroom' ? 'Classroom' : ''].filter(Boolean).join(' · ')}
          {` · ${c.lectureCount} lecture${c.lectureCount === 1 ? '' : 's'} · ${c.cardCount} cards`}
        </small>
      </span>
      <span className="row">
        <Link className="btn small" to={`/record?class=${c.id}`}>
          Record
        </Link>
        <button className="link danger" onClick={onArchive} aria-label={`Archive ${c.name}`}>
          ✕
        </button>
      </span>
    </li>
  );
}

/** School: classes (manual or Google Classroom), recorder, study library; students also get assignments, study log, exams, campus. */
export default function School() {
  const { viewing, me } = useSession();
  const confirm = useConfirm();
  const key = viewing?.key ?? null;
  const { data, error, setData } = useLoad<SchoolResponse>(key ? withMember('/api/school', key) : null);
  const [msg, setMsg] = useState<string | null>(new URLSearchParams(window.location.search).get('classroom') === 'error' ? 'Google Classroom did not connect. Try again.' : null);
  const [asg, setAsg] = useState({ name: '', classId: '', due: '', priority: 'Medium' });
  const [study, setStudy] = useState({ classId: '', minutes: '25', location: '' });
  const [exam, setExam] = useState({ name: '', course: '', date: '' });
  const [campus, setCampus] = useState({ name: '', kind: 'Tutoring', phone: '', email: '' });
  if (!viewing) return null;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const student = me.xpTrack === 'student' && viewing.key === me.member?.key;

  const run = async (p: Promise<SchoolResponse | WithEarn>, ok?: string): Promise<void> => {
    try {
      const r = await p;
      setData('school' in r ? r.school : r);
      setMsg(ok ?? null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const path = (p: string): string => withMember(p, key);
  const connect = async (): Promise<void> => {
    try {
      const r = await api<{ imported: number; authUrl: string | null; school?: SchoolResponse }>(path('/api/classroom/connect'), 'POST');
      if (r.authUrl) window.location.href = r.authUrl;
      else {
        if (r.school) setData(r.school);
        setMsg(`Imported ${r.imported} class${r.imported === 1 ? '' : 'es'} from Google Classroom ✓`);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not connect');
    }
  };

  return (
    <section>
      <h1>School</h1>
      <p className="muted">
        <Link to="/classroom-mode">Classroom mode →</Link>
      </p>
      {msg && <p className="muted" role="status">{msg}</p>}

      {data.todayClasses.length > 0 && (
        <div className="card now" data-testid="today-classes">
          <small>TODAY</small>
          {data.todayClasses.map((c) => (
            <div key={c.id} className="row" style={{ marginTop: 6 }}>
              <span className="grow">
                <b>{c.name}</b> <span className="muted small">{c.startTime} {c.room}</span>
              </span>
              <Link className="btn small" to={`/record?class=${c.id}`}>
                Record
              </Link>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Classes</h2>
        {data.classes.length === 0 && <p className="muted">Add your classes, or bring them in from Google Classroom.</p>}
        <ul className="plain rows" data-testid="classes">
          {data.classes.map((c) => (
            <ClassRow
              key={c.id}
              c={c}
              onArchive={() =>
                void confirm({ title: `Archive ${c.name}?`, body: 'Its notes and flashcards stay in your library.', confirmLabel: 'Archive' }).then(
                  (yes) => void (yes && run(api<SchoolResponse>(path(`/api/classes/${c.id}/archive`), 'POST'))),
                )
              }
            />
          ))}
        </ul>
        <ClassForm onSave={(b) => run(api<SchoolResponse>(path('/api/classes'), 'POST', b), 'Class added ✓')} />
        <button className="btn small ghost" onClick={() => void connect()} style={{ marginTop: 8 }}>
          Connect Google Classroom
        </button>
        <p className="muted small">Read-only: MyDay only reads your class list. It never posts or turns anything in.</p>
      </div>

      {student && (
        <>
          <div className="card" data-testid="assignments">
            <h2>Assignments</h2>
            <ul className="plain rows">
              {data.assignments.map((a) => (
                <li key={a.id}>
                  <span className={a.overdue ? 'warn' : ''}>
                    {a.name} <small className="muted">{[a.className, a.due && due(a.due), a.priority].filter(Boolean).join(' · ')}</small>
                  </span>
                  <button className="btn small" onClick={() => void run(api<WithEarn>(path(`/api/school/assignments/${a.id}/done`), 'POST'), 'Done ✓ +20 XP')}>
                    Done
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="form wide"
              onSubmit={(e) => {
                e.preventDefault();
                void run(api<SchoolResponse>(path('/api/school/assignments'), 'POST', { ...asg, classId: asg.classId ? Number(asg.classId) : null })).then(() => setAsg({ ...asg, name: '', due: '' }));
              }}
            >
              <input value={asg.name} onChange={(e) => setAsg({ ...asg, name: e.target.value })} placeholder="Assignment" required />
              <select value={asg.classId} onChange={(e) => setAsg({ ...asg, classId: e.target.value })} aria-label="Class">
                <option value="">No class</option>
                {data.classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <input type="date" value={asg.due} onChange={(e) => setAsg({ ...asg, due: e.target.value })} aria-label="Due" />
              <select value={asg.priority} onChange={(e) => setAsg({ ...asg, priority: e.target.value })} aria-label="Priority">
                <option>High</option>
                <option>Medium</option>
                <option>Low</option>
              </select>
              <button className="btn small">Add</button>
            </form>
          </div>

          <div className="card" data-testid="study-log">
            <h2>Study sessions</h2>
            <p className="muted small">
              {data.studyToday} min today · {data.studyWeek} min this week
            </p>
            <form
              className="form wide"
              onSubmit={(e) => {
                e.preventDefault();
                void run(api<WithEarn>(path('/api/school/study'), 'POST', { classId: study.classId ? Number(study.classId) : null, minutes: Number(study.minutes), location: study.location, subject: '' }), 'Study session logged ✓ +15 XP');
              }}
            >
              <select value={study.classId} onChange={(e) => setStudy({ ...study, classId: e.target.value })} aria-label="Class">
                <option value="">General</option>
                {data.classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <input inputMode="numeric" value={study.minutes} onChange={(e) => setStudy({ ...study, minutes: e.target.value.replace(/\D/g, '') })} aria-label="Minutes" />
              <input value={study.location} onChange={(e) => setStudy({ ...study, location: e.target.value })} placeholder="Where (library…)" />
              <button className="btn small">Log</button>
            </form>
          </div>

          <div className="card" data-testid="exams">
            <h2>Exams</h2>
            <ul className="plain rows">
              {data.exams.map((x) => (
                <li key={x.id}>
                  <span>
                    {x.name} <small className="muted">{[x.course, x.date, x.daysLeft !== null && `${x.daysLeft} days`, `${x.prepCount} prep`].filter(Boolean).join(' · ')}</small>
                  </span>
                  <span className="row">
                    <button className="btn small" onClick={() => void run(api<WithEarn>(path(`/api/school/exams/${x.id}/prep`), 'POST'), 'Prep logged ✓')}>
                      Prepped
                    </button>
                    <button className="link danger" aria-label={`Delete ${x.name}`} onClick={() => void confirm({ title: `Delete ${x.name}?`, confirmLabel: 'Delete', danger: true }).then((y) => void (y && run(api<SchoolResponse>(path(`/api/school/exams/${x.id}`), 'DELETE'))))}>
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <form
              className="form wide"
              onSubmit={(e) => {
                e.preventDefault();
                void run(api<SchoolResponse>(path('/api/school/exams'), 'POST', exam)).then(() => setExam({ name: '', course: '', date: '' }));
              }}
            >
              <input value={exam.name} onChange={(e) => setExam({ ...exam, name: e.target.value })} placeholder="Exam" required />
              <input value={exam.course} onChange={(e) => setExam({ ...exam, course: e.target.value })} placeholder="Course" />
              <input type="date" value={exam.date} onChange={(e) => setExam({ ...exam, date: e.target.value })} aria-label="Date" />
              <button className="btn small">Add</button>
            </form>
          </div>

          <div className="card" data-testid="campus">
            <h2>Campus support</h2>
            <ul className="plain rows">
              {data.campus.map((c) => (
                <li key={c.id}>
                  <span>
                    <b>{c.name}</b> <small className="muted">{[c.kind, c.phone, c.email, `${c.visits} visits`].filter(Boolean).join(' · ')}</small>
                  </span>
                  <span className="row">
                    <button className="btn small" onClick={() => void run(api<SchoolResponse | WithEarn>(path(`/api/school/campus/${c.id}/visit`), 'POST'), 'Visit logged ✓')}>
                      I went
                    </button>
                    <button className="link danger" aria-label={`Delete ${c.name}`} onClick={() => void confirm({ title: `Remove ${c.name}?`, confirmLabel: 'Remove', danger: true }).then((y) => void (y && run(api<SchoolResponse>(path(`/api/school/campus/${c.id}`), 'DELETE'))))}>
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <form
              className="form wide"
              onSubmit={(e) => {
                e.preventDefault();
                void run(api<SchoolResponse>(path('/api/school/campus'), 'POST', campus)).then(() => setCampus({ ...campus, name: '', phone: '', email: '' }));
              }}
            >
              <input value={campus.name} onChange={(e) => setCampus({ ...campus, name: e.target.value })} placeholder="Office / person" required />
              <select value={campus.kind} onChange={(e) => setCampus({ ...campus, kind: e.target.value })} aria-label="Kind">
                {['Tutoring', 'Office hours', 'Advising', 'Counseling', 'Disability services', 'Writing center', 'Other'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <input value={campus.phone} onChange={(e) => setCampus({ ...campus, phone: e.target.value })} placeholder="Phone" />
              <input value={campus.email} onChange={(e) => setCampus({ ...campus, email: e.target.value })} placeholder="Email" />
              <button className="btn small">Add</button>
            </form>
          </div>
        </>
      )}
    </section>
  );
}
