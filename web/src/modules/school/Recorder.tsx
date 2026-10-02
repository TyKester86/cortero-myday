import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { SchoolResponse, UploadLectureResponse } from '@myday/shared';
import { api, ApiFail, useLoad } from '../../api';

const HOLD_MS = 1500;

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

/** One-time: check the school's recording rules and get permission. */
function PolicyScreen({ onAck }: { onAck: () => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <section data-testid="recording-policy">
      <h1>Before you record</h1>
      <div className="card">
        <p>Recording a class is a big deal. Before you use this the first time:</p>
        <ol>
          <li>Check your school's rules about recording class. Some schools and some states require the teacher's OK.</li>
          <li>Ask your teacher if it's okay to record for your own notes.</li>
          <li>If you're under 18, a parent should know you're using this.</li>
        </ol>
        <p className="small muted">
          Your recordings are private: only you can see the notes. The audio is deleted after it's turned into notes. Never share
          recordings of other people.
        </p>
        <label className="inline-label">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I checked my school's policy and have
          permission
        </label>
        <button className="btn" disabled={!checked} onClick={onAck}>
          Continue
        </button>
      </div>
      <Link to="/school">Back</Link>
    </section>
  );
}

/**
 * Kid-facing lecture recorder. Pick the class, tap to start, and the screen
 * goes OLED-black with one dim dot (saves battery, isn't distracting). To stop,
 * press and HOLD the circle — a single accidental tap can't end it.
 */
export default function Recorder() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { data, error, reload } = useLoad<SchoolResponse>('/api/school');
  const [classId, setClassId] = useState<string>(params.get('class') ?? '');
  const [phase, setPhase] = useState<'idle' | 'recording' | 'uploading' | 'failed'>('idle');
  const [hold, setHold] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const blob = useRef<Blob | null>(null);
  const holdTimer = useRef<number | null>(null);
  const lock = useRef<{ release: () => Promise<void> } | null>(null);

  useEffect(
    () => () => {
      rec.current?.stream.getTracks().forEach((t) => t.stop());
      void lock.current?.release().catch(() => undefined);
    },
    [],
  );

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.recordingAcknowledged) {
    return <PolicyScreen onAck={() => void api('/api/lectures/ack', 'POST').then(reload)} />;
  }

  const upload = async (): Promise<void> => {
    if (!blob.current) return;
    setPhase('uploading');
    setErr(null);
    const durationS = Math.round((Date.now() - started.current) / 1000);
    try {
      const res = await fetch(`/api/lectures/upload?classId=${encodeURIComponent(classId)}&durationS=${durationS}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': blob.current.type || 'audio/webm', 'X-MyDay-Upload': '1' },
        body: blob.current,
      });
      const out = (await res.json().catch(() => null)) as (UploadLectureResponse & { error?: string }) | null;
      if (!res.ok || !out?.lecture) throw new ApiFail(res.status, out?.error ?? 'Upload failed');
      blob.current = null;
      nav(`/lectures/${out.lecture.id}`);
    } catch (e) {
      setPhase('failed');
      setErr(e instanceof ApiFail && e.status ? e.message : 'Could not upload — your recording is still here. Try again when you have signal.');
    }
  };

  const start = async (): Promise<void> => {
    setErr(null);
    const mime = pickMime();
    if (!navigator.mediaDevices?.getUserMedia || !mime) {
      setErr('This browser can’t record audio. Try Safari on iPhone or Chrome on Android.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const r = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24000 });
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        blob.current = new Blob(chunks.current, { type: mime.split(';')[0] });
        void upload();
      };
      r.start(10_000);
      rec.current = r;
      started.current = Date.now();
      setPhase('recording');
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        lock.current = (await wl?.request('screen')) ?? null;
      } catch {
        /* screen may dim; recording continues */
      }
    } catch {
      setErr('Microphone permission is needed to record.');
    }
  };

  const beginHold = (): void => {
    const t0 = Date.now();
    holdTimer.current = window.setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / HOLD_MS);
      setHold(p);
      if (p >= 1) {
        endHold();
        void lock.current?.release().catch(() => undefined);
        rec.current?.stop();
      }
    }, 50);
  };
  const endHold = (): void => {
    if (holdTimer.current) window.clearInterval(holdTimer.current);
    holdTimer.current = null;
    setHold(0);
  };

  if (phase === 'recording') {
    return (
      <div className="recorder" data-testid="recorder-live">
        <i className="dot live" aria-label="Recording" />
        <button
          className="hold"
          onPointerDown={beginHold}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="Press and hold to stop recording"
        >
          <div className="ring" style={{ ['--p' as string]: `${Math.round(hold * 100)}%` }}>
            <span>hold to stop</span>
          </div>
        </button>
      </div>
    );
  }

  return (
    <section>
      <h1>Record a class</h1>
      {data.classes.length === 0 ? (
        <p className="muted">
          Add your classes first on the <Link to="/school">School</Link> page.
        </p>
      ) : (
        <div className="card">
          <label className="form">
            Which class?
            <select value={classId} onChange={(e) => setClassId(e.target.value)} data-testid="record-class">
              <option value="">Pick a class</option>
              {data.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {phase === 'uploading' ? (
            <p className="muted">Saving your recording… notes will be ready in a few minutes.</p>
          ) : phase === 'failed' ? (
            <button className="btn block" onClick={() => void upload()}>
              Try upload again
            </button>
          ) : (
            <button className="btn block" disabled={!classId} onClick={() => void start()}>
              ● Start recording
            </button>
          )}
          <p className="muted small">The screen goes black while recording. Press and hold the circle to stop.</p>
          {err && <p className="error">{err}</p>}
        </div>
      )}
    </section>
  );
}
