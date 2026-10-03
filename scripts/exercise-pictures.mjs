#!/usr/bin/env node
/**
 * Wire exercise demo pictures into the year programs.
 *
 *   1. Put the demo images in web/public/exercises/ (any file names).
 *   2. npm run build -w api   (this reads the compiled programs)
 *   3. node scripts/exercise-pictures.mjs
 *
 * Every exercise used by the 9 programs is matched to a picture by its words;
 * the result is written to api/content/exercise-images.json (commit it) and
 * every gap / unused file is reported. Exit 1 if any exercise has no picture.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { matchPictures } from './lib/match-pictures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prog = await import(pathToFileURL(path.join(root, 'api', 'dist', 'lib', 'program.js')).href);
const { BUILDS } = await import(pathToFileURL(path.join(root, 'shared', 'dist', 'index.js')).href);

const names = new Set();
const hints = {};
for (const b of BUILDS) for (const lvl of ['beginner', 'experienced']) for (const r of prog.programRows(b, prog.buildPhases(b, lvl))) {
  names.add(r.exercise);
  hints[r.exercise] = r.equipment;
}
const all = [...names].sort();
const dir = path.join(root, 'web', 'public', 'exercises');
const { map, missing, unused } = matchPictures(all, dir, undefined, hints);
// Pictures for movements the programs don't use yet are wired too, under a readable name,
// so any plan that includes them (CSV plans, future library additions) shows them.
const EXPAND = { db: 'dumbbell', smith: 'Smith' };
const nameOf = (f) => {
  const w = f.replace(/\.[a-z0-9]+$/i, '').split(/[-_]+/).map((x) => EXPAND[x] ?? x).join(' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const extras = Object.fromEntries(unused.map((f) => [nameOf(f), `/exercises/${f}`]));
const out = Object.fromEntries([...Object.entries(map).map(([n, f]) => [n, `/exercises/${f}`]), ...Object.entries(extras)].sort());
writeFileSync(path.join(root, 'api', 'content', 'exercise-images.json'), `${JSON.stringify(out, null, 2)}\n`);

console.log(`${all.length} exercises in the 9 programs · ${Object.keys(map).length} wired`);
for (const [n, f] of Object.entries(map)) console.log(`  ✓ ${n.padEnd(28)} ← ${f}`);
if (missing.length) console.log(`\nNO PICTURE (${missing.length}):\n${missing.map((n) => `  ✗ ${n}`).join('\n')}`);
if (unused.length) console.log(`\nAlso wired for movements the programs don't use yet (${unused.length}):\n${Object.keys(extras).map((n) => `  + ${n}`).join('\n')}`);
process.exit(missing.length ? 1 : 0);
