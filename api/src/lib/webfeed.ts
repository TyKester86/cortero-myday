/**
 * "Around the Web": articles from trusted ADHD publishers, read from their RSS
 * feeds a few times a day. Each item is screened by the community pre-screen
 * (lib/screen.ts) before anyone sees it; held items stay hidden. The Feed
 * shows a labeled card (publisher, title, a short summary) that links out —
 * MyDay never republishes the article.
 *
 * The lineup: CHADD; Child Mind Institute (their feed covers all of children's
 * mental health, so only ADHD topics are kept); ADDitude through Google News'
 * RSS (additudemag.com blocks our server's address; Google fetches it instead —
 * durable fix: ask ADDitude to allowlist us). Understood.org is out: no public
 * feed, and their terms forbid automated fetching.
 *
 * WEB_FEEDS overrides the list: "key|Publisher|https://feed-url|options, ..."
 * where options (comma-separated, optional) are "adhd" (keep ADHD topics only)
 * and "gnews" (a Google News feed: strip " - Publisher" from titles, no summary).
 * Tests point it at local feeds.
 */
import { asSystem, pool } from '../db.js';
import { registerJob } from './schedulers.js';
import { screenText } from './screen.js';

export interface WebSource {
  key: string;
  publisher: string;
  url: string;
  /** Keep only ADHD topics (for publishers that cover more than ADHD). */
  adhdOnly?: boolean;
  /** A Google News RSS proxy: titles end " - Publisher"; the description is just a link (no summary). */
  gnews?: boolean;
}

const DEFAULT_SOURCES: WebSource[] = [
  { key: 'chadd', publisher: 'CHADD', url: 'https://chadd.org/feed/' },
  { key: 'childmind', publisher: 'Child Mind Institute', url: 'https://childmind.org/feed/', adhdOnly: true },
  { key: 'additude', publisher: 'ADDitude', url: 'https://news.google.com/rss/search?q=site:additudemag.com&hl=en-US&gl=US&ceid=US:en', gnews: true },
];

/** ADHD topics: ADHD / ADD (as words, any case for ADHD, upper-case ADD), attention, focus, executive function. */
export function isAdhdTopic(text: string): boolean {
  return /\badhd\b/i.test(text) || /\bADD\b/.test(text) || /\b(attention|focus(ed|ing)?|executive function(s|ing)?)\b/i.test(text);
}

export function webSources(): WebSource[] {
  const raw = process.env.WEB_FEEDS?.trim();
  if (!raw) return DEFAULT_SOURCES;
  return raw
    .split(/,(?=\s*[\w-]+\|)/)
    .map((s) => s.trim().split('|'))
    .filter((p) => (p.length === 3 || p.length === 4) && /^https?:\/\//.test(p[2] ?? ''))
    .map(([key = '', publisher = '', url = '', opts = '']) => {
      const o = opts.split(/[\s,;]+/);
      return { key: key.trim(), publisher: publisher.trim(), url: url.trim(), adhdOnly: o.includes('adhd'), gnews: o.includes('gnews') };
    });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}
const text = (html: string): string =>
  decode(decode(html))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const tag = (item: string, name: string): string => item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '';

export interface ParsedItem {
  url: string;
  title: string;
  summary: string;
  publishedAt: Date;
}

/** RSS 2.0 <item>s (and Atom <entry>s): link, title, a ~240-char summary, date. */
export function parseFeed(xml: string): ParsedItem[] {
  const out: ParsedItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const it = m[0];
    const link = text(tag(it, 'link')) || (it.match(/<link[^>]+href="([^"]+)"/i)?.[1] ?? '');
    const title = text(tag(it, 'title'));
    if (!/^https:\/\//.test(link) || !title) continue;
    let summary = text(tag(it, 'description') || tag(it, 'summary'));
    summary = summary.replace(/\s*(The post .* appeared first on .*|Continue reading.*|Read more.*)$/i, '');
    if (summary.length > 240) summary = `${summary.slice(0, 237).replace(/\s+\S*$/, '')}…`;
    const when = new Date(text(tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated')));
    out.push({ url: link, title: title.slice(0, 200), summary, publishedAt: Number.isNaN(when.getTime()) ? new Date() : when });
  }
  return out;
}

/** Fetch every source, screen new items, store them. Returns how many new items were stored. */
export async function refreshWebFeeds(): Promise<{ added: number; hidden: number }> {
  let added = 0;
  let hidden = 0;
  for (const src of webSources()) {
    let xml = '';
    try {
      const res = await fetch(src.url, { headers: { 'User-Agent': 'MyDay feed reader (+https://conquermyday.app)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      xml = await res.text();
    } catch (e) {
      console.error('web feed fetch failed', src.key, e instanceof Error ? e.message : e);
      continue;
    }
    // Newest first (a Google News feed isn't in date order), then the publisher-specific clean-up.
    const items = parseFeed(xml)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .map((it) => (src.gnews ? { ...it, title: it.title.replace(new RegExp(`\\s+[-–—]\\s+${src.publisher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), ''), summary: '' } : it))
      .filter((it) => !src.adhdOnly || isAdhdTopic(`${it.title} ${it.summary}`));
    for (const it of items.slice(0, 20)) {
      const { rowCount } = await asSystem(() => pool.query('SELECT 1 FROM web_items WHERE url = $1', [it.url]));
      if (rowCount) continue;
      const s = await screenText(`${it.title}\n\n${it.summary}`);
      const status = s.hold ? 'hidden' : 'visible';
      if (s.hold) hidden += 1;
      await asSystem(() =>
        pool.query(
          'INSERT INTO web_items (source, publisher, url, title, summary, published_at, status, flags) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (url) DO NOTHING',
          [src.key, src.publisher, it.url, it.title, it.summary, it.publishedAt, status, s.reasons],
        ),
      );
      added += 1;
    }
  }
  return { added, hidden };
}

registerJob({ name: 'web-feeds', everyMs: 3 * 60 * 60 * 1000, run: async () => void (await refreshWebFeeds()) });
