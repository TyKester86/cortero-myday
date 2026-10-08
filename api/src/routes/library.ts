/**
 * The Library: the book MyDay is built on (Conquer ADHD Everyday) and Hana's
 * curated ADHD medical reference — the same library Hana answers from — to
 * read directly, with every medical entry's source and date.
 */
import { Router } from 'express';
import type { LibraryChapter, LibraryContents, LibrarySearchResult, LibraryTopic } from '@myday/shared';
import { BOOK_TITLE, bookChapter, bookContents, citeBook, citeMedical, medicalReference, searchLibrary } from '../lib/library.js';
import { HttpError } from '../lib/http.js';
import { self } from '../lib/members.js';

export const libraryRouter = Router();

const SLUG = /^[a-z0-9-]{1,120}$/;

libraryRouter.get('/api/library', (req, res) => {
  self(req);
  const med = medicalReference();
  const out: LibraryContents = {
    bookTitle: BOOK_TITLE,
    chapters: bookContents().map((c) => ({ slug: c.slug, title: c.title, sections: c.sections.length, minutes: c.minutes })),
    medical: {
      lastReviewed: med.lastReviewed,
      nextReviewDue: med.nextReviewDue,
      topics: med.topics.map((t) => ({ slug: t.slug, title: t.title, entries: t.entries.length })),
    },
  };
  res.json(out);
});

libraryRouter.get('/api/library/book/:slug', (req, res) => {
  self(req);
  const slug = String(req.params.slug);
  const c = SLUG.test(slug) ? bookChapter(slug) : null;
  if (!c) throw new HttpError(404, 'No such chapter');
  const out: LibraryChapter = {
    bookTitle: BOOK_TITLE,
    slug: c.slug,
    title: c.title,
    markdown: c.markdown,
    prev: c.prev ? { slug: c.prev.slug, title: c.prev.title } : null,
    next: c.next ? { slug: c.next.slug, title: c.next.title } : null,
  };
  res.json(out);
});

libraryRouter.get('/api/library/medical/:slug', (req, res) => {
  self(req);
  const med = medicalReference();
  const t = med.topics.find((x) => x.slug === String(req.params.slug));
  if (!t) throw new HttpError(404, 'No such topic');
  const out: LibraryTopic = {
    slug: t.slug,
    title: t.title,
    lastReviewed: med.lastReviewed,
    entries: t.entries.map((e) => ({ topic: e.topic, summary: e.summary, source: e.source, url: e.url })),
  };
  res.json(out);
});

libraryRouter.get('/api/library/search', (req, res) => {
  self(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  const out: LibrarySearchResult = { q, book: [], medical: [] };
  if (q.length >= 2) {
    const found = searchLibrary(q, { book: 6, medical: 6, loose: true });
    out.book = found.book.map((p) => ({ slug: p.slug, chapter: p.chapter, section: p.section, excerpt: p.text.length > 320 ? `${p.text.slice(0, 317).replace(/\s+\S*$/, '')}…` : p.text, citation: citeBook(p) }));
    out.medical = found.medical.map((e) => ({ topicSlug: e.file.replace(/\.md$/, ''), topic: e.topic, summary: e.summary, source: e.source, url: e.url, citation: citeMedical(e) }));
  }
  res.json(out);
});
