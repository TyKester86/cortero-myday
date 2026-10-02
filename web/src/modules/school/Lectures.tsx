import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { LectureSummary, SchoolResponse, UploadLectureResponse } from '@myday/shared';
import { useLoad } from '../../api';

const STATUS: Record<LectureSummary['status'], string> = {
  uploaded: 'in line',
  transcribing: 'listening…',
  structuring: 'writing notes…',
  ready: 'notes ready',
  failed: 'failed',
};

/** Lectures: every recording you've made, by class — record a new one or upload an audio file. */
export default function Lectures() {
  const nav = useNavigate();
  const school = useLoad<SchoolResponse>('/api/school');
  const list = useLoad<{ lectures: LectureSummary[] }>('/api/lectures');
  const [classId, setClassId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (school.error) return <p className="error">{school.error}</p>;
  if (!school.data || !list.data) return <p className="muted">Loading…</p>;
  const classes = school.data.classes;
  const name = (id: number): string => classes.find((c) => c.id === id)?.name ?? 'Class';

  const upload = async (file: File): Promise<void> => {
    if (!classId) {
      setMsg('Pick the class first.');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setMsg('That file is over 25 MB — trim it or record in two parts.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/lectures/upload?classId=${encodeURIComponent(classId)}&durationS=0`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type || 'audio/mpeg', 'X-MyDay-Upload': '1' },
        body: file,
      });
      const out = (await res.json().catch(() => null)) as (UploadLectureResponse & { error?: string }) | null;
      if (!res.ok || !out?.lecture) throw new Error(out?.error ?? 'Upload failed');
      nav(`/lectures/${out.lecture.id}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>Lectures</h1>
      {classes.length === 0 ? (
        <p className="muted">
          Add your classes on the <Link to="/school">School</Link> page first — every lecture is filed under its class.
        </p>
      ) : (
        <div className="card" data-testid="lecture-new">
          <h2>New lecture</h2>
          <div className="form">
            <select value={classId} onChange={(e) => setClassId(e.target.value)} aria-label="Class">
              <option value="">Which class?</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <div className="row">
              <Link className={classId ? 'btn small' : 'btn small ghost'} to={classId ? `/record?class=${classId}` : '/record'}>
                ● Record now
              </Link>
              <label className="btn small ghost" style={{ cursor: 'pointer' }}>
                {busy ? 'Uploading…' : 'Upload a recording'}
                <input
                  type="file"
                  accept="audio/*,video/webm"
                  style={{ display: 'none' }}
                  data-testid="lecture-upload"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            <p className="muted small">Audio up to 25 MB (about 2 hours of voice). It’s deleted once your notes are made.</p>
            {msg && <p className="error">{msg}</p>}
          </div>
        </div>
      )}
      <div className="card" data-testid="lecture-list">
        <h2>Your lectures</h2>
        {list.data.lectures.length === 0 && <p className="muted">None yet.</p>}
        <ul className="plain rows">
          {list.data.lectures.map((l) => (
            <li key={l.id}>
              <span className="grow">
                <Link to={`/lectures/${l.id}`}>{l.title || 'Lecture'}</Link>{' '}
                <small className="muted">
                  {name(l.classId)} · {l.recordedOn}
                </small>
              </span>
              <span className={l.status === 'ready' ? 'pill good' : l.status === 'failed' ? 'pill' : 'pill sun'}>{STATUS[l.status]}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
