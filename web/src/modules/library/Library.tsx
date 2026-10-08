import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { LibraryChapter, LibraryContents, LibrarySearchResult, LibraryTopic } from '@myday/shared';
import { useLoad } from '../../api';
import Markdown from '../../components/Markdown';
import { count } from '../../format';

const NOT_ADVICE = 'Plain-language summaries of the research for families — not medical advice, and not a substitute for your doctor.';

/** The book MyDay is built on, and Hana's curated ADHD medical reference — the library Hana answers from. */
export default function Library() {
  const { data, error } = useLoad<LibraryContents>('/api/library');
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState('');
  const results = useLoad<LibrarySearchResult>(asked ? `/api/library/search?q=${encodeURIComponent(asked)}` : null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const search = (e: FormEvent): void => {
    e.preventDefault();
    setAsked(q.trim());
  };
  const r = results.data;
  return (
    <section className="library" data-testid="library">
      <h1>Library</h1>
      <p className="muted small">The book MyDay is built on and a curated ADHD medical reference, with every source cited. It’s the same library Hana answers from.</p>
      <form className="inline" onSubmit={search} role="search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: sleep, medication, routines…" aria-label="Search the library" />
        <button className="btn small" disabled={q.trim().length < 2}>
          Search
        </button>
      </form>
      {asked && r && (
        <div className="card" data-testid="library-results">
          <h2>Results for “{r.q}”</h2>
          {r.book.length === 0 && r.medical.length === 0 && <p className="muted small">Nothing in the library matches that. Try a simpler word.</p>}
          {r.book.map((b, i) => (
            <div key={`b${i}`} className="lib-hit" data-testid="library-hit-book">
              <Link to={`/library/book/${b.slug}`}>
                <b>{b.section || b.chapter}</b>
              </Link>
              <p className="small">{b.excerpt}</p>
              <p className="small muted">{b.citation}</p>
            </div>
          ))}
          {r.medical.map((m, i) => (
            <div key={`m${i}`} className="lib-hit" data-testid="library-hit-medical">
              <Link to={`/library/medical/${m.topicSlug}`}>
                <b>{m.topic}</b>
              </Link>
              <p className="small">{m.summary}</p>
              <p className="small muted">
                Source:{' '}
                <a href={m.url} target="_blank" rel="noopener noreferrer">
                  {m.source}
                </a>
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="card" data-testid="library-book">
        <h2>
          <i>{data.bookTitle}</i>
        </h2>
        <p className="small muted">{count(data.chapters.length, 'part')}: chapters, appendices and the bibliography.</p>
        <ol className="plain lib-list">
          {data.chapters.map((c) => (
            <li key={c.slug}>
              <Link to={`/library/book/${c.slug}`} data-testid="library-chapter">
                {c.title}
              </Link>
              <small className="muted">{` · ${c.minutes} min read`}</small>
            </li>
          ))}
        </ol>
      </div>

      <div className="card" data-testid="library-medical">
        <h2>ADHD medical reference</h2>
        <p className="small muted">
          {`${count(data.medical.topics.reduce((n, t) => n + t.entries, 0), 'entry', 'entries')} from the CDC, NIMH, NICE, the American Academy of Pediatrics and peer-reviewed research, each with its source and date.`}
          {data.medical.lastReviewed && ` Last reviewed ${data.medical.lastReviewed}${data.medical.nextReviewDue ? `; next review ${data.medical.nextReviewDue}` : ''}.`}
        </p>
        <ul className="plain lib-list">
          {data.medical.topics.map((t) => (
            <li key={t.slug}>
              <Link to={`/library/medical/${t.slug}`} data-testid="library-topic">
                {t.title}
              </Link>
              <small className="muted">{` · ${count(t.entries, 'entry', 'entries')}`}</small>
            </li>
          ))}
        </ul>
        <p className="small muted">{NOT_ADVICE}</p>
      </div>
    </section>
  );
}

/** One chapter of the book, to read. */
export function LibraryChapterPage() {
  const { slug = '' } = useParams();
  const { data, error } = useLoad<LibraryChapter>(`/api/library/book/${encodeURIComponent(slug)}`);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <article className="library-read" data-testid="library-chapter-page">
      <p className="small">
        <Link to="/library">← Library</Link> · <i>{data.bookTitle}</i>
      </p>
      <h1>{data.title}</h1>
      <div className="lib-text">
        <Markdown text={data.markdown} />
      </div>
      <nav className="lib-pager" aria-label="Chapters">
        {data.prev ? <Link to={`/library/book/${data.prev.slug}`}>{`← ${data.prev.title}`}</Link> : <span />}
        {data.next ? <Link to={`/library/book/${data.next.slug}`} data-testid="library-next">{`${data.next.title} →`}</Link> : <span />}
      </nav>
    </article>
  );
}

/** One topic of the medical reference: every entry with its source, date and link. */
export function LibraryTopicPage() {
  const { slug = '' } = useParams();
  const { data, error } = useLoad<LibraryTopic>(`/api/library/medical/${encodeURIComponent(slug)}`);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <article className="library-read" data-testid="library-topic-page">
      <p className="small">
        <Link to="/library">← Library</Link> · ADHD medical reference
      </p>
      <h1>{data.title}</h1>
      {data.entries.map((e) => (
        <div key={e.topic} className="card lib-entry" data-testid="library-entry">
          <h2>{e.topic}</h2>
          <p>{e.summary}</p>
          <p className="small muted">
            Source:{' '}
            <a href={e.url} target="_blank" rel="noopener noreferrer" data-testid="library-source">
              {e.source}
            </a>
          </p>
        </div>
      ))}
      <p className="small muted">
        {NOT_ADVICE}
        {data.lastReviewed && ` Last reviewed ${data.lastReviewed}.`}
      </p>
    </article>
  );
}
