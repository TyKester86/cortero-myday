import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Lecture as LectureData, LectureNotes } from '@myday/shared';
import { api, useLoad } from '../../api';

const STATUS: Record<string, string> = {
  uploaded: 'Saved — getting in line…',
  transcribing: 'Listening to the recording…',
  structuring: 'Writing your notes…',
};

export function NotesView({ n }: { n: LectureNotes }) {
  return (
    <div className="notes" data-testid="lecture-notes">
      <p>
        <b>Summary.</b> {n.summary}
      </p>
      {n.sections.map((s, i) => (
        <div key={i}>
          <h3>{s.heading}</h3>
          <ul>
            {s.points.map((p, j) => (
              <li key={j}>{p}</li>
            ))}
          </ul>
        </div>
      ))}
      {n.keyPoints.length > 0 && (
        <>
          <h3>Key points</h3>
          <ul>
            {n.keyPoints.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </>
      )}
      {n.terms.length > 0 && (
        <>
          <h3>Terms</h3>
          <ul>
            {n.terms.map((t, i) => (
              <li key={i}>
                <b>{t.term}</b> — {t.definition}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** One lecture: processing status, the student's own draft first (scaffold), then the notes, assignments and cards. */
export default function Lecture() {
  const { id } = useParams();
  const { data, error, setData, reload } = useLoad<LectureData>(id ? `/api/lectures/${encodeURIComponent(id)}` : null);
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const processing = data && data.status !== 'ready' && data.status !== 'failed';

  useEffect(() => {
    if (!processing) return;
    const t = window.setTimeout(reload, 3000);
    return () => window.clearTimeout(t);
  }, [processing, data, reload]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const act = async (p: Promise<LectureData>, ok: string): Promise<void> => {
    try {
      setData(await p);
      setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const owed = data.status === 'ready' && data.scaffold !== 'none' && !data.revealed;
  const part = data.scaffold === 'key_points' ? 'key points' : 'summary';

  return (
    <section>
      <p>
        <Link to={`/study/${data.classId}`}>← {data.className}</Link>
      </p>
      <h1>{data.title || data.className}</h1>
      <p className="muted small">
        {data.recordedOn} · {Math.round(data.durationS / 60)} min
      </p>
      {processing && (
        <div className="card" data-testid="lecture-processing">
          {STATUS[data.status] ?? 'Working…'} <span className="muted small">You can leave — it keeps going.</span>
        </div>
      )}
      {data.status === 'failed' && <p className="error">{data.error || 'This recording could not be processed.'}</p>}

      {owed && (
        <div className="card" data-testid="scaffold">
          <h2>Your turn first</h2>
          <p className="small">
            Before you see the AI notes, write the <b>{part}</b> in your own words — even 2–3 lines. That's how notes stick. Then compare.
          </p>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={4000} placeholder={`My ${part}…`} />
          <button
            className="btn"
            disabled={draft.trim().length < 10}
            onClick={() => void act(api<LectureData>(`/api/lectures/${data.id}/draft`, 'POST', { part: data.scaffold, draft }), 'Nice — now compare with the notes.')}
          >
            Save my draft and show the notes
          </button>
        </div>
      )}

      {data.notes && (
        <div className="card">
          {Object.entries(data.drafts).map(([k, v]) => (
            <p key={k} className="small">
              <b>Your {k === 'key_points' ? 'key points' : 'summary'}:</b> {v}
            </p>
          ))}
          <NotesView n={data.notes} />
        </div>
      )}

      {data.assignments.filter((a) => !a.dismissed && !a.homeworkId).length > 0 && (
        <div className="card" data-testid="detected-assignments">
          <h2>Heard some homework</h2>
          <ul className="plain rows">
            {data.assignments
              .filter((a) => !a.dismissed && !a.homeworkId)
              .map((a) => (
                <li key={a.id}>
                  <span>
                    {a.title} {a.due && <small className="muted">· due {a.due}</small>}
                  </span>
                  <span className="row">
                    <button className="btn small" onClick={() => void act(api<LectureData>(`/api/lectures/${data.id}/assignments/${a.id}/add`, 'POST'), 'Added to your homework ✓')}>
                      Add
                    </button>
                    <button className="link" onClick={() => void act(api<LectureData>(`/api/lectures/${data.id}/assignments/${a.id}/dismiss`, 'POST'), 'Dismissed')}>
                      Not homework
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
      {data.status === 'ready' && (
        <div className="row">
          <Link className="btn small" to={`/study/${data.classId}`}>
            Flashcards ({data.cardCount})
          </Link>
          <Link className="btn small ghost" to={`/tutor?lecture=${data.id}`}>
            Quiz me on this
          </Link>
        </div>
      )}
      {msg && <p className="muted small">{msg}</p>}
    </section>
  );
}
