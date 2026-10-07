/**
 * Hana's library: what she reads before answering about ADHD.
 *   1. The book — "Conquer ADHD Everyday" by T. Hunter (api/content/book/*.md,
 *      one file per chapter).
 *   2. The medical reference (api/content/medical/*.md): curated entries from
 *      CDC, NIMH, the AAP guideline, NICE NG87 and peer-reviewed reviews, each
 *      with a plain summary, its source + date and the source's URL.
 * Search is simple and offline (word overlap weighted by how rare a word is),
 * so it costs nothing per question and needs no extra service.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOOK_TITLE = 'Conquer ADHD Everyday';
const CONTENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content');

export interface BookPassage {
  kind: 'book';
  /** "Chapter 4: Medication — What the Research Actually Says" */
  chapter: string;
  /** The section heading inside the chapter, when there is one. */
  section: string;
  text: string;
}

export interface MedicalEntry {
  kind: 'medical';
  topic: string;
  file: string;
  summary: string;
  source: string;
  url: string;
}

export type LibraryItem = BookPassage | MedicalEntry;

const STOP = new Set(
  ('about after again also because been before being both could does doing done each even every from have having into just like make made more most much must need only other over really same should some still such than that their them then there these they this those through very want were what when where which while will with would your yours ours mine ' +
    'adhd kids kid child children parent parents people person things thing time help helps does dont cant isnt know think good well also many much ways able lot lots')
    .split(' '),
);
const stem = (w: string): string => w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '');
export function terms(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).map((w) => w.replace(/'s$/, '')).filter((w) => !STOP.has(w) && w.length >= 3).map(stem);
}

function readDir(dir: string): Array<{ file: string; text: string }> {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .sort()
      .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), 'utf8') }));
  } catch {
    return [];
  }
}

/** Book chapters → passages of about 80–260 words, keeping the section heading they sit under. */
function loadBook(): BookPassage[] {
  const out: BookPassage[] = [];
  for (const { file, text } of readDir(path.join(CONTENT, 'book'))) {
    if (file.startsWith('bibliography')) continue; // a reference list, not something to answer from
    const chapter = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.replace(/\.md$/, '');
    let section = '';
    let buf: string[] = [];
    const flush = (): void => {
      const t = buf.join(' ').trim();
      if (t.split(/\s+/).length >= 25) out.push({ kind: 'book', chapter, section, text: t });
      buf = [];
    };
    for (const block of text.split(/\n\s*\n/)) {
      const b = block.trim();
      if (!b || b.startsWith('# ')) continue;
      if (b.startsWith('## ')) {
        flush();
        section = b.slice(3).trim();
        continue;
      }
      const clean = b.replace(/^>\s?/gm, '').replace(/^\*(.+)\*$/, '$1');
      buf.push(clean);
      if (buf.join(' ').split(/\s+/).length >= 160) flush();
    }
    flush();
  }
  return out;
}

/** Medical entries: "### Title" blocks with summary / source / url lines. */
function loadMedical(): { entries: MedicalEntry[]; lastReviewed: string | null } {
  const entries: MedicalEntry[] = [];
  for (const { file, text } of readDir(path.join(CONTENT, 'medical'))) {
    for (const block of text.split(/^###\s+/m).slice(1)) {
      const [title = '', ...rest] = block.split('\n');
      const field = (k: string): string => rest.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? '';
      const e: MedicalEntry = { kind: 'medical', topic: title.trim(), file, summary: field('summary'), source: field('source'), url: field('url') };
      if (e.topic && e.summary && e.source && e.url) entries.push(e);
    }
  }
  let lastReviewed: string | null = null;
  try {
    lastReviewed = readFileSync(path.join(CONTENT, 'medical', 'README.md'), 'utf8').match(/corpus_last_reviewed:\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  } catch {
    /* no README */
  }
  return { entries, lastReviewed };
}

interface Indexed<T> {
  item: T;
  tf: Map<string, number>;
}
interface Library {
  book: Array<Indexed<BookPassage>>;
  medical: Array<Indexed<MedicalEntry>>;
  idf: Map<string, number>;
  lastReviewed: string | null;
}

let lib: Library | null = null;
const textOf = (i: LibraryItem): string => (i.kind === 'book' ? `${i.chapter} ${i.section} ${i.section} ${i.text}` : `${i.topic} ${i.topic} ${i.summary}`);

function library(): Library {
  if (lib) return lib;
  const book = loadBook();
  const { entries, lastReviewed } = loadMedical();
  const all: LibraryItem[] = [...book, ...entries];
  const df = new Map<string, number>();
  const index = <T extends LibraryItem>(item: T): Indexed<T> => {
    const tf = new Map<string, number>();
    for (const t of terms(textOf(item))) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { item, tf };
  };
  const b = book.map(index);
  const m = entries.map(index);
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + all.length / n));
  lib = { book: b, medical: m, idf, lastReviewed };
  return lib;
}

/** For tests and status: what's loaded. */
export function libraryStats(): { bookPassages: number; chapters: number; medicalEntries: number; lastReviewed: string | null } {
  const l = library();
  return { bookPassages: l.book.length, chapters: new Set(l.book.map((x) => x.item.chapter)).size, medicalEntries: l.medical.length, lastReviewed: l.lastReviewed };
}

function rank<T extends LibraryItem>(pool: Array<Indexed<T>>, q: string[], idf: Map<string, number>, max: number, minScore: number): Array<{ item: T; score: number }> {
  const uniq = [...new Set(q)];
  return pool
    .map(({ item, tf }) => {
      let score = 0;
      let hits = 0;
      for (const t of uniq) {
        const n = tf.get(t);
        if (n) {
          hits += 1;
          score += (idf.get(t) ?? 0) * (1 + Math.log(n));
        }
      }
      // Reward covering more of the question, not one word repeated.
      return { item, score: hits >= 2 ? score * (hits / uniq.length + 0.5) : 0 };
    })
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

/** The most relevant book passages and medical entries for a question (book first). */
export function searchLibrary(question: string, o: { book?: number; medical?: number } = {}): { book: BookPassage[]; medical: MedicalEntry[] } {
  const l = library();
  const q = terms(question);
  if (!q.length) return { book: [], medical: [] };
  return {
    book: rank(l.book, q, l.idf, o.book ?? 3, 4).map((x) => x.item),
    medical: rank(l.medical, q, l.idf, o.medical ?? 3, 4).map((x) => x.item),
  };
}

/** How to cite it, in plain words. */
export function citeBook(p: BookPassage): string {
  const ch = p.chapter.replace(/^Chapter (\d+):\s*/, 'Chapter $1, “').replace(/^(Chapter \d+, “.+)$/, '$1”');
  return `${BOOK_TITLE}, ${ch}`;
}
export function citeMedical(e: MedicalEntry): string {
  return e.source;
}

/**
 * The library excerpts for Hana's system prompt (book first, then the medical
 * reference): passages for this message plus the last couple of questions, so
 * a follow-up still sees what her earlier answers were based on.
 */
export function libraryBrief(question: string, earlier: string[] = []): string {
  const now = searchLibrary(question);
  const before = earlier.slice(-2).map((q) => searchLibrary(q, { book: 2, medical: 2 }));
  const book = [...new Set([...now.book, ...before.flatMap((b) => b.book)])].slice(0, 6);
  const medical = [...new Set([...now.medical, ...before.flatMap((b) => b.medical)])].slice(0, 6);
  if (!book.length && !medical.length) return '';
  const parts: string[] = [];
  if (book.length) {
    parts.push(
      `FROM THE BOOK "${BOOK_TITLE}" by T. Hunter (consult first):\n` +
        book.map((p, i) => `[B${i + 1}] ${citeBook(p)}${p.section ? ` — section “${p.section}”` : ''}:\n${p.text.slice(0, 1400)}`).join('\n\n'),
    );
  }
  if (medical.length) {
    parts.push(
      `FROM THE MEDICAL REFERENCE (consult second; reviewed ${library().lastReviewed ?? 'recently'}):\n` +
        medical.map((e, i) => `[M${i + 1}] ${e.topic} — source: ${e.source} — ${e.url}\n${e.summary}`).join('\n\n'),
    );
  }
  return parts.join('\n\n');
}
