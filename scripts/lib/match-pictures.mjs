/**
 * Match picture files to names (exercises, meals) by their words, so the
 * pictures can arrive with whatever file names they were exported with.
 *
 *   "03_barbell-back-squat.webp"  ↔  "Back squat"
 *   "chicken_burrito_bowl.webp"   ↔  "Chicken burrito bowls"
 */
import { readdirSync } from 'node:fs';

const STOP = new Set(['the', 'a', 'an', 'and', 'with', 'of', 'on', 'in', 'style', 'demo', 'exercise', 'image', 'img', 'photo', 'final', 'v1', 'v2']);
const SYN = { db: 'dumbbell', bb: 'barbell', pullup: 'pull', pushup: 'push', situp: 'sit', tri: 'triceps', pressdown: 'pushdown', biceps: 'curl', ohp: 'overhead', rdl: 'romanian', bowls: 'bowl', tacos: 'taco', wraps: 'wrap', burritos: 'burrito' };

export function words(s) {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !/^\d+$/.test(w) && !STOP.has(w))
    .map((w) => SYN[w] ?? (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

function score(a, b, hint = '') {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  // Every word of the name should be in the file name; extra file words cost a little,
  // unless they agree with the hint (e.g. the exercise's equipment: dumbbell vs cable).
  const H = new Set(words(hint));
  let hinted = 0;
  for (const w of B) if (!A.has(w) && H.has(w)) hinted++;
  return both / A.size - 0.05 * Math.max(0, B.size - both - hinted) + 0.01 * hinted;
}

/**
 * Best one-to-one match of names → files in `dir` (extensions given).
 * Returns { map: {name: file}, missing: [names], unused: [files] }.
 */
export function matchPictures(names, dir, exts = ['.webp', '.png', '.jpg', '.jpeg'], hints = {}) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)) && !f.startsWith('_'));
  } catch {
    files = [];
  }
  const pairs = [];
  for (const n of names) for (const f of files) {
    const s = score(n, f, hints[n] ?? '');
    if (s >= 0.75) pairs.push([s, n, f]);
  }
  pairs.sort((x, y) => y[0] - x[0]);
  const map = {};
  const used = new Set();
  for (const [, n, f] of pairs) {
    if (map[n] || used.has(f)) continue;
    map[n] = f;
    used.add(f);
  }
  return { map, missing: names.filter((n) => !map[n]), unused: files.filter((f) => !used.has(f)) };
}
