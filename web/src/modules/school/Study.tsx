import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Flashcard, StudyView } from '@myday/shared';
import { api, useLoad } from '../../api';

/** Per-class study library: every lecture (kept forever), flashcards in Leitner boxes, quiz history. */
export default function Study() {
  const { classId } = useParams();
  const { data, error, setData } = useLoad<StudyView>(classId ? `/api/study/${encodeURIComponent(classId)}` : null);
  const [flipped, setFlipped] = useState(false);
  const [card, setCard] = useState({ front: '', back: '' });
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  // Lowest box first: the cards you know least come up most.
  const next: Flashcard | undefined = [...data.cards].sort((a, b) => a.box - b.box || a.id - b.id)[0];
  const answer = async (correct: boolean): Promise<void> => {
    if (!next) return;
    setFlipped(false);
    setData(await api<StudyView>(`/api/study/cards/${next.id}/answer`, 'POST', { correct }));
  };
  const boxes = [1, 2, 3, 4, 5].map((b) => data.cards.filter((c) => c.box === b).length);

  return (
    <section>
      <p>
        <Link to="/school">← School</Link>
      </p>
      <h1>{data.cls.name}</h1>
      <p className="muted small">
        {data.lectures.length} lectures · {data.cards.length} flashcards
        {data.accuracy !== null && ` · ${data.accuracy}% right lately`}
      </p>
      <div className="row">
        <Link className="btn small" to={`/record?class=${data.cls.id}`}>
          Record this class
        </Link>
      </div>

      <div className="card" data-testid="flashcards">
        <h2>Flashcards</h2>
        {next ? (
          <>
            <div className="boxes" aria-label="Cards per box">
              {boxes.map((n, i) => (
                <span key={i}>
                  Box {i + 1}: {n}
                </span>
              ))}
            </div>
            <div className="flash">
              <button className={flipped ? 'face back' : 'face'} onClick={() => setFlipped(!flipped)} data-testid="flashcard">
                {flipped ? (
                  <span>
                    <b>{next.back}</b>
                    {next.explanation && (
                      <>
                        <br />
                        <small className="muted">{next.explanation}</small>
                      </>
                    )}
                  </span>
                ) : (
                  next.front
                )}
              </button>
            </div>
            {flipped ? (
              <div className="row">
                <button className="btn small" onClick={() => void answer(true)}>
                  I knew it
                </button>
                <button className="btn small ghost" onClick={() => void answer(false)}>
                  Not yet
                </button>
              </div>
            ) : (
              <p className="muted small">Tap the card to flip it.</p>
            )}
          </>
        ) : (
          <p className="muted">No cards yet — record a lecture or add your own.</p>
        )}
        <details>
          <summary>Add my own card</summary>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void api<StudyView>(`/api/study/${data.cls.id}/cards`, 'POST', card)
                .then((v) => {
                  setData(v);
                  setCard({ front: '', back: '' });
                  setMsg('Card added ✓');
                })
                .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not add'));
            }}
          >
            <input value={card.front} onChange={(e) => setCard({ ...card, front: e.target.value })} placeholder="Question" required maxLength={300} />
            <input value={card.back} onChange={(e) => setCard({ ...card, back: e.target.value })} placeholder="Answer" required maxLength={600} />
            <button className="btn small">Add card</button>
          </form>
        </details>
        {msg && <p className="muted small">{msg}</p>}
      </div>

      <div className="card" data-testid="lectures">
        <h2>Lectures</h2>
        {data.lectures.length === 0 && <p className="muted">None yet.</p>}
        <ul className="plain rows">
          {data.lectures.map((l) => (
            <li key={l.id}>
              <Link to={`/lectures/${l.id}`}>{l.title || 'Lecture'}</Link>
              <small className="muted">
                {l.recordedOn} {l.status !== 'ready' && `· ${l.status}`}
              </small>
            </li>
          ))}
        </ul>
      </div>

      {data.quiz.length > 0 && (
        <div className="card">
          <h2>Quiz history</h2>
          <ul className="plain small">
            {data.quiz.map((q) => (
              <li key={q.date}>
                {q.date}: {q.correct}/{q.total} right
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
