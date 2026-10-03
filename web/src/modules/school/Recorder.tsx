import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { SchoolResponse, UploadLectureResponse } from '@myday/shared';
import { api, ApiFail, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import {
  beginRecording,
  finishRecording,
  flushRecordings,
  onUploaded,
  removeRecording,
  retryRecording,
  saveChunk,
  setRecordingClass,
  usePendingRecordings,
  type PendingRecording,
} from '../../recordings';
import { useSession } from '../../session';

const HOLD_MS = 1500;
/** Audio is saved to the device every few seconds while recording. */
const CHUNK_MS = 5_000;

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

/** What the recorder needs from /api/school, remembered on the device so the page works with no signal. */
interface SchoolLite {
  classes: Array<{ id: number; name: string }>;
  recordingAcknowledged: boolean;
}
const LITE_KEY = (userId: number): string => `myday.recorder.${userId}`;
function readLite(userId: number): SchoolLite | null {
  try {
    const raw = localStorage.getItem(LITE_KEY(userId));
    return raw ? (JSON.parse(raw) as SchoolLite) : null;
  } catch {
    return null;
  }
}
function writeLite(userId: number, d: SchoolResponse): void {
  try {
    localStorage.setItem(LITE_KEY(userId), JSON.stringify({ classes: d.classes.map((c) => ({ id: c.id, name: c.name })), recordingAcknowledged: d.recordingAcknowledged }));
  } catch {
    /* per-device convenience only */
  }
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

const minutes = (r: PendingRecording): string => {
  const m = Math.max(0, Math.round((r.lastChunkAt - r.startedAt) / 60_000));
  return m < 1 ? 'under a minute' : `${m} min`;
};
const when = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Recordings saved on this phone that haven't reached the server yet. */
function WaitingList({ userId, classes }: { userId: number; classes: SchoolLite['classes'] }) {
  const pending = usePendingRecordings().filter((r) => r.state !== 'recording');
  const confirm = useConfirm();
  if (!pending.length) return null;
  const mine = pending.filter((r) => r.userId === userId);
  const others = pending.length - mine.length;
  return (
    <div className="card" data-testid="waiting-uploads">
      <h2>Waiting to upload</h2>
      <p className="small muted">Saved on this phone — safe even if the app closes. They upload by themselves when there's signal, then they're removed from the phone.</p>
      <ul className="plain">
        {mine.map((r) => (
          <li key={r.id} className="row small" data-testid="waiting-item" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="grow">
              <b>{r.className || 'Class not picked yet'}</b> · {when(r.startedAt)} · {minutes(r)}
              <br />
              <span className="muted">
                {r.state === 'uploading'
                  ? 'Uploading…'
                  : r.classId === null
                    ? 'Pick the class so it can upload.'
                    : r.stuck
                      ? `Couldn’t upload: ${r.lastError}`
                      : navigator.onLine
                        ? r.lastError || 'Waiting to upload…'
                        : 'Waiting for signal.'}
              </span>
            </span>
            {r.classId === null && classes.length > 0 && (
              <select
                aria-label="Which class was this?"
                defaultValue=""
                onChange={(e) => {
                  const c = classes.find((x) => x.id === Number(e.target.value));
                  if (c) void setRecordingClass(r.id, c.id, c.name).then(() => flushRecordings(userId));
                }}
              >
                <option value="">Which class?</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {r.state !== 'uploading' && r.classId !== null && (
              <button className="link" onClick={() => void retryRecording(r.id, userId)}>
                Upload now
              </button>
            )}
            {r.state !== 'uploading' && (
              <button
                className="link"
                onClick={() =>
                  void confirm({ title: 'Delete this recording?', body: 'It hasn’t uploaded yet, so there won’t be notes for it.', confirmLabel: 'Delete', danger: true }).then(
                    async (ok) => {
                      if (ok) await removeRecording(r.id);
                    },
                  )
                }
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      {others > 0 && <p className="small muted">{others} more on this phone from someone else — they upload when that person signs in.</p>}
    </div>
  );
}

/**
 * Kid-facing lecture recorder. Pick the class, tap to start, and the screen
 * goes OLED-black with one dim dot (saves battery, isn't distracting). To stop,
 * press and HOLD the circle — a single accidental tap can't end it.
 *
 * The audio is saved on the phone every few seconds while recording, so no
 * signal (or a phone that closes the app) never loses a lecture.
 */
export default function Recorder() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { me } = useSession();
  const userId = me.userId;
  const { data, error, reload } = useLoad<SchoolResponse>('/api/school');
  const [classId, setClassId] = useState<string>(params.get('class') ?? '');
  const [phase, setPhase] = useState<'idle' | 'recording' | 'uploading' | 'saved' | 'failed'>('idle');
  const [hold, setHold] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const blob = useRef<Blob | null>(null);
  const holdTimer = useRef<number | null>(null);
  const lock = useRef<{ release: () => Promise<void> } | null>(null);
  const recId = useRef<string | null>(null);
  /** Saving to the device failed (storage full / blocked): fall back to uploading from memory. */
  const deviceFailed = useRef(false);
  const saving = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (data) writeLite(userId, data);
  }, [data, userId]);

  // The recording just made: open its notes when it lands (if the kid is still here).
  useEffect(
    () =>
      onUploaded((r) => {
        if (r.id === recId.current && r.lectureId) nav(`/lectures/${r.lectureId}`);
      }),
    [nav],
  );

  useEffect(
    () => () => {
      rec.current?.stream.getTracks().forEach((t) => t.stop());
      void lock.current?.release().catch(() => undefined);
    },
    [],
  );

  // No signal and the class list can't load: use what this phone remembers.
  const lite: SchoolLite | null = data ? { classes: data.classes, recordingAcknowledged: data.recordingAcknowledged } : error ? readLite(userId) : null;
  if (!lite && error) {
    return (
      <section>
        <h1>Record a class</h1>
        <p className="muted">You’re offline, and this phone hasn’t opened the recorder before. Open it once with signal; after that it works anywhere.</p>
        <WaitingList userId={userId} classes={[]} />
      </section>
    );
  }
  if (!lite) return <p className="muted">Loading…</p>;
  if (!me.aiAllowed) {
    return (
      <section data-testid="needs-consent">
        <h1>Record a class</h1>
        <div className="card">
          <p>Your notes are made by an AI helper, so a grown-up needs to turn it on for you first.</p>
          <p className="small muted">Ask them to open their Family page → “AI helpers for kids under 13”.</p>
        </div>
      </section>
    );
  }
  if (!lite.recordingAcknowledged) {
    if (!data) return <p className="muted">You’re offline. The one-time recording screen needs signal.</p>;
    return <PolicyScreen onAck={() => void api('/api/lectures/ack', 'POST').then(reload)} />;
  }

  /** Fallback only (device storage unavailable): upload straight from memory, as before. */
  const uploadFromMemory = async (): Promise<void> => {
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
      setErr(e instanceof ApiFail && e.status ? e.message : 'Could not upload — your recording is still here. Keep this page open and try again when you have signal.');
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
      const type = mime.split(';')[0] ?? 'audio/webm';
      const cls = lite.classes.find((c) => String(c.id) === classId);
      chunks.current = [];
      deviceFailed.current = false;
      recId.current = null;
      try {
        recId.current = await beginRecording({ userId, classId: cls?.id ?? null, className: cls?.name ?? '', mime: type });
      } catch {
        deviceFailed.current = true;
      }
      let seq = 0;
      r.ondataavailable = (e) => {
        if (!e.data.size) return;
        chunks.current.push(e.data);
        const id = recId.current;
        if (!id || deviceFailed.current) return;
        const n = seq++;
        // In order, one after another.
        saving.current = saving.current.then(() =>
          saveChunk(id, n, e.data).catch(() => {
            deviceFailed.current = true;
            setErr('This phone’s storage is full — keep this page open until the recording uploads.');
          }),
        );
      };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        blob.current = new Blob(chunks.current, { type });
        void (async () => {
          await saving.current;
          const id = recId.current;
          if (!id || deviceFailed.current) {
            if (id) await removeRecording(id).catch(() => undefined);
            void uploadFromMemory();
            return;
          }
          await finishRecording(id);
          blob.current = null;
          chunks.current = [];
          if (navigator.onLine) {
            setPhase('uploading');
            await flushRecordings(userId);
          }
          setPhase('saved');
        })();
      };
      r.start(CHUNK_MS);
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
      {!data && <p className="small muted" data-testid="recorder-offline">No signal — you can still record. It saves on this phone and uploads later.</p>}
      {lite.classes.length === 0 ? (
        <p className="muted">
          Add your classes first on the <Link to="/school">School</Link> page.
        </p>
      ) : (
        <div className="card">
          <label className="form">
            Which class?
            <select value={classId} onChange={(e) => setClassId(e.target.value)} data-testid="record-class">
              <option value="">Pick a class</option>
              {lite.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {phase === 'uploading' ? (
            <p className="muted">Uploading your recording… notes will be ready in a few minutes.</p>
          ) : phase === 'failed' ? (
            <button className="btn block" onClick={() => void uploadFromMemory()}>
              Try upload again
            </button>
          ) : (
            <>
              {phase === 'saved' && (
                <p className="small" data-testid="recording-saved">
                  Saved on this phone ✓ It uploads by itself when there’s signal — you can close the app.
                </p>
              )}
              <button className="btn block" disabled={!classId} onClick={() => void start()}>
                ● Start recording
              </button>
            </>
          )}
          <p className="muted small">The screen goes black while recording. Press and hold the circle to stop.</p>
          {err && <p className="error">{err}</p>}
        </div>
      )}
      <WaitingList userId={userId} classes={lite.classes} />
    </section>
  );
}
