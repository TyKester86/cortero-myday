/**
 * Meetings (grown-ups only): tap record, talk, tap stop. The audio saves on the
 * phone as you go (the same offline capture as lectures) and uploads when
 * there's signal; the server transcribes it and Hana writes the notes —
 * summary, decisions, action items, follow-ups. One tap puts an action item in
 * your tasks with a reminder. Private to you.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Meeting, MeetingSummary } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { beginRecording, finishRecording, flushRecordings, onUploaded, removeRecording, retryRecording, saveChunk, usePendingRecordings } from '../../recordings';
import { useSession } from '../../session';

const CHUNK_MS = 5_000;

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const length = (s: number): string => (s < 60 ? `${s}s` : `${Math.round(s / 60)} min`);
const when = (iso: string | number): string =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const STATUS: Record<Meeting['status'], string> = {
  uploaded: 'Getting ready…',
  transcribing: 'Turning speech into text…',
  structuring: 'Hana is writing the notes…',
  ready: 'Notes ready',
  failed: 'Needs a retry',
};

/** Recordings on this phone that haven't uploaded yet. */
function Waiting({ userId }: { userId: number }) {
  const pending = usePendingRecordings().filter((r) => r.kind === 'meeting' && r.userId === userId && r.state !== 'recording');
  const confirm = useConfirm();
  if (!pending.length) return null;
  return (
    <div className="card" data-testid="meeting-waiting">
      <h2>Waiting to upload</h2>
      <p className="small muted">Saved on this phone — safe even if the app closes. They upload by themselves when there’s signal.</p>
      <ul className="plain rows">
        {pending.map((r) => (
          <li key={r.id} className="small">
            <span className="grow">
              {when(r.startedAt)} · {length(Math.round((r.lastChunkAt - r.startedAt) / 1000))}
              <br />
              <span className="muted">{r.state === 'uploading' ? 'Uploading…' : r.stuck ? `Couldn’t upload: ${r.lastError}` : navigator.onLine ? r.lastError || 'Waiting to upload…' : 'Waiting for signal.'}</span>
            </span>
            {r.state !== 'uploading' && (
              <>
                <button className="link small" onClick={() => void retryRecording(r.id, userId)}>
                  Upload now
                </button>
                <button
                  className="link danger small"
                  onClick={() =>
                    void confirm({ title: 'Delete this recording?', body: 'It hasn’t uploaded yet, so there won’t be notes for it.', confirmLabel: 'Delete', danger: true }).then(
                      (y) => void (y && removeRecording(r.id)),
                    )
                  }
                >
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Meetings() {
  const { me } = useSession();
  const nav = useNavigate();
  const userId = me.userId;
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, reload } = useLoad<{ meetings: MeetingSummary[] }>(`/api/meetings${search ? `?q=${encodeURIComponent(search)}` : ''}`);
  const [phase, setPhase] = useState<'idle' | 'recording' | 'saving'>('idle');
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const recId = useRef<string | null>(null);
  const started = useRef(0);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const lock = useRef<{ release: () => Promise<void> } | null>(null);

  // The meeting just recorded: open its notes page as soon as it lands.
  useEffect(
    () =>
      onUploaded((r) => {
        if (r.meetingId && r.id === recId.current) nav(`/meetings/${r.meetingId}`);
        else reload();
      }),
    [nav, reload],
  );
  // While recording: tick the clock, and warn before the page is closed or reloaded.
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = window.setInterval(() => setSecs(Math.round((Date.now() - started.current) / 1000)), 500);
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('beforeunload', warn);
    };
  }, [phase]);
  useEffect(
    () => () => {
      rec.current?.stream.getTracks().forEach((t) => t.stop());
      void lock.current?.release().catch(() => undefined);
    },
    [],
  );

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
      recId.current = await beginRecording({ kind: 'meeting', userId, classId: null, className: '', mime: type });
      let seq = 0;
      r.ondataavailable = (e) => {
        const id = recId.current;
        if (!e.data.size || !id) return;
        const n = seq++;
        saving.current = saving.current.then(() => saveChunk(id, n, e.data).catch(() => setErr('This phone’s storage is full — keep this page open until it uploads.')));
      };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void (async () => {
          await saving.current;
          if (recId.current) await finishRecording(recId.current);
          setPhase('saving');
          await flushRecordings(userId);
          setPhase('idle');
          reload();
        })();
      };
      r.start(CHUNK_MS);
      rec.current = r;
      started.current = Date.now();
      setSecs(0);
      setPhase('recording');
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        lock.current = (await wl?.request('screen')) ?? null;
      } catch {
        /* the screen may dim; recording continues */
      }
    } catch {
      setErr('Microphone permission is needed to record.');
    }
  };

  const stop = (): void => {
    void lock.current?.release().catch(() => undefined);
    rec.current?.stop();
  };

  if (phase === 'recording') {
    return (
      <div className="meeting-live" data-testid="meeting-live" role="dialog" aria-label="Recording a meeting">
        <span className="live-dot" aria-hidden="true" />
        <p className="live-label">Recording</p>
        <p className="live-clock" data-testid="meeting-clock" aria-live="off">
          {clock(secs)}
        </p>
        <p className="small live-hint">Keep this screen open. It saves to your phone every few seconds.</p>
        <button className="btn live-stop" onClick={stop} data-testid="meeting-stop">
          ■ Stop
        </button>
      </div>
    );
  }

  return (
    <section data-testid="meetings">
      <h1>Meetings</h1>
      <p className="muted small">Record a meeting and Hana writes the notes: summary, decisions, action items and follow-ups. Only you can see them.</p>
      <div className="card meeting-start">
        <button className="record-big" onClick={() => void start()} disabled={phase === 'saving'} data-testid="meeting-record" aria-label="Start recording a meeting">
          <span aria-hidden="true" />
        </button>
        <div>
          <b>{phase === 'saving' ? 'Saving and uploading…' : 'Tap to record'}</b>
          <p className="small muted">Let everyone know you’re recording — some states require everyone’s OK.</p>
        </div>
      </div>
      {err && <p className="error">{err}</p>}
      <Waiting userId={userId} />
      <form
        className="inline"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your meeting notes" aria-label="Search your meeting notes" />
        <button className="btn small">Search</button>
      </form>
      {search && (
        <p className="small muted">
          Results for “{search}” ·{' '}
          <button
            className="link small"
            onClick={() => {
              setQ('');
              setSearch('');
            }}
          >
            Clear
          </button>
        </p>
      )}
      <ul className="plain meeting-list" data-testid="meeting-list">
        {data?.meetings.map((m) => (
          <li key={m.id}>
            <Link to={`/meetings/${m.id}`} className="card meeting-row">
              <b>{m.title || 'Meeting'}</b>
              <small className="muted">
                {when(m.recordedAt)} · {length(m.durationS)}
                {m.status !== 'ready' && ` · ${STATUS[m.status]}`}
              </small>
            </Link>
          </li>
        ))}
      </ul>
      {data && !data.meetings.length && <p className="muted">{search ? 'Nothing matches.' : 'No meetings yet.'}</p>}
    </section>
  );
}

export function MeetingPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const { data, error, setData, reload } = useLoad<Meeting>(`/api/meetings/${encodeURIComponent(id ?? '')}`);
  const [title, setTitle] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const working = !!data && data.status !== 'ready' && data.status !== 'failed';
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(reload, 2500);
    return () => window.clearInterval(t);
  }, [working, reload]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const n = data.notes;
  const add = (i: number): void =>
    void api<{ meeting: Meeting; day: string; remindAt: string }>(`/api/meetings/${data.id}/actions/${i}/task`, 'POST')
      .then((r) => {
        setData(r.meeting);
        setMsg(`Added to your tasks for ${new Date(`${r.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} — reminder ${when(r.remindAt)}.`);
      })
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Couldn’t add it'));
  return (
    <section data-testid="meeting">
      <p>
        <Link to="/meetings">← Meetings</Link>
      </p>
      <form
        className="meeting-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (title === null || !title.trim()) return;
          void api<Meeting>(`/api/meetings/${data.id}`, 'PATCH', { title }).then((m) => {
            setData(m);
            setTitle(null);
          });
        }}
      >
        <input
          className="title-input"
          value={title ?? (data.title || 'Meeting')}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Meeting title"
          maxLength={120}
          data-testid="meeting-title"
        />
        {title !== null && <button className="btn small">Save title</button>}
      </form>
      <p className="small muted">
        {when(data.recordedAt)} · {length(data.durationS)}
      </p>
      {working && (
        <p className="card note" role="status" data-testid="meeting-working">
          {STATUS[data.status]} This usually takes a minute or two.
        </p>
      )}
      {data.status === 'failed' && (
        <div className="card note" role="alert" data-testid="meeting-failed">
          <p>{data.error || 'Something went wrong.'}</p>
          {data.audioKept && <p className="small">Your recording is kept — nothing is lost.</p>}
          <button className="btn small" onClick={() => void api<Meeting>(`/api/meetings/${data.id}/retry`, 'POST').then(setData)} data-testid="meeting-retry">
            Try again
          </button>
        </div>
      )}
      {msg && <p className="good small" role="status">{msg}</p>}
      {n && (
        <>
          <div className="card" data-testid="meeting-summary">
            <h2>Summary</h2>
            <p>{n.summary}</p>
          </div>
          {n.actionItems.length > 0 && (
            <div className="card" data-testid="meeting-actions">
              <h2>Action items</h2>
              <ul className="plain rows">
                {n.actionItems.map((a, i) => (
                  <li key={i} data-testid="action-item">
                    <span className="grow">
                      {a.task}
                      {(a.owner || a.due) && (
                        <small className="muted">
                          {' '}
                          · {[a.owner, a.due && `due ${new Date(`${a.due}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`].filter(Boolean).join(' · ')}
                        </small>
                      )}
                    </span>
                    {a.taskId ? (
                      <span className="pill good">In your tasks ✓</span>
                    ) : (
                      <button className="btn small" onClick={() => add(i)} data-testid="add-to-tasks">
                        Add to tasks
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {n.decisions.length > 0 && (
            <div className="card">
              <h2>Decisions</h2>
              <ul>
                {n.decisions.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {n.followUps.length > 0 && (
            <div className="card">
              <h2>Follow-ups &amp; open questions</h2>
              <ul>
                {n.followUps.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {data.transcript && (
        <details className="card" data-testid="meeting-transcript">
          <summary>
            <b>Transcript</b>
          </summary>
          <p className="transcript">{data.transcript}</p>
        </details>
      )}
      <button
        className="link danger small"
        onClick={() =>
          void confirm({ title: 'Delete this meeting?', body: 'Its notes, transcript and any saved audio are deleted. Tasks you added stay.', confirmLabel: 'Delete', danger: true }).then(
            (y) => void (y && api(`/api/meetings/${data.id}`, 'DELETE').then(() => nav('/meetings'))),
          )
        }
      >
        Delete this meeting
      </button>
    </section>
  );
}
