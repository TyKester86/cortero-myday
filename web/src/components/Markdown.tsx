/**
 * Hana's replies, formatted: **bold**, *italic*, `code`, [links](https://…),
 * bare https links, headings, bullet and numbered lists, rules and line
 * breaks. Built from React elements (no raw HTML), so nothing in a reply can
 * inject markup — and raw markdown never shows.
 */
import type { ReactNode } from 'react';

// (No lookbehind: older iPhone Safari can't parse it, and one bad regex would break the whole app.)
const INLINE = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\s\n][^*\n]*?\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])/g;

function link(href: string, label: string, key: string): ReactNode {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

/** One line of text → plain text + formatted pieces. */
export function inline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const t = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${n++}`;
    if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={key}>{inline(t.slice(2, -2), key)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={key}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const mm = t.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      out.push(mm ? link(mm[2] ?? '', mm[1] ?? '', key) : t);
    } else if (t.startsWith('http')) out.push(link(t, t.length > 48 ? `${t.slice(0, 45)}…` : t, key));
    else out.push(<em key={key}>{inline(t.slice(1, -1), key)}</em>);
    last = at + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block = { kind: 'p'; lines: string[] } | { kind: 'list'; ordered: boolean; items: string[]; start: number } | { kind: 'h'; text: string } | { kind: 'hr' };

export function blocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const prev = out[out.length - 1];
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const num = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
    if (!line.trim()) {
      out.push({ kind: 'p', lines: [] }); // a blank line ends the current block
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) out.push({ kind: 'hr' });
    else if (/^#{1,6}\s+/.test(line)) out.push({ kind: 'h', text: line.replace(/^#{1,6}\s+/, '') });
    else if (bullet) {
      if (prev?.kind === 'list' && !prev.ordered) prev.items.push(bullet[1] ?? '');
      else out.push({ kind: 'list', ordered: false, items: [bullet[1] ?? ''], start: 1 });
    } else if (num) {
      if (prev?.kind === 'list' && prev.ordered) prev.items.push(num[2] ?? '');
      else out.push({ kind: 'list', ordered: true, items: [num[2] ?? ''], start: Number(num[1]) || 1 });
    } else if (prev?.kind === 'list' && /^\s{2,}\S/.test(raw)) {
      // an indented continuation of the last list item
      prev.items[prev.items.length - 1] += ` ${line.trim()}`;
    } else if (prev?.kind === 'p' && prev.lines.length) prev.lines.push(line);
    else out.push({ kind: 'p', lines: [line] });
  }
  return out.filter((b) => b.kind !== 'p' || b.lines.length);
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {blocks(text).map((b, i) => {
        const k = `b${i}`;
        if (b.kind === 'hr') return <hr key={k} />;
        if (b.kind === 'h') return <p key={k} className="md-h"><strong>{inline(b.text, k)}</strong></p>;
        if (b.kind === 'list') {
          const items = b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>);
          return b.ordered ? <ol key={k} start={b.start}>{items}</ol> : <ul key={k}>{items}</ul>;
        }
        return (
          <p key={k}>
            {b.lines.flatMap((l, j) => (j ? [<br key={`br${j}`} />, ...inline(l, `${k}-${j}`)] : inline(l, `${k}-${j}`)))}
          </p>
        );
      })}
    </div>
  );
}
