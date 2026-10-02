#!/usr/bin/env node
/**
 * L2 button audit: no dead controls.
 *
 *  1. Every <button> in the web app has a handler: an onClick, or it submits
 *     a <form> that has an onSubmit (type="submit" / default inside a form).
 *  2. Every API call the web app makes (api(), fetch(), href="/api/…")
 *     matches a route the API actually registers, method included.
 *  3. Every in-app link (<Link to>, navigate(), href="/…") points at a
 *     registered page route.
 *
 * Usage: node scripts/button-audit.mjs   (exit 1 on any dead control)
 * Exported audit() is also run by scripts/e2e.mjs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, ext) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (ext.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

/** Normalize a path: template expressions and :params become "*", query strings dropped. */
function norm(p) {
  return p
    .replace(/\?.*$/, '')
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/:[A-Za-z]+/g, '*')
    .replace(/\/+$/, '') || '/';
}

function matches(pattern, actual) {
  const a = pattern.split('/');
  const b = actual.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === '*' || b[i] === '*' || seg === b[i] || (seg.includes('*') && new RegExp(`^${seg.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`).test(b[i])));
}

/** Read the end of a JSX opening tag starting at `i` (handles nested {} and quotes). */
function tagAt(src, i) {
  let depth = 0;
  let q = null;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (q) {
      if (ch === q && src[j - 1] !== '\\') q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

export function audit() {
  const problems = [];
  const webFiles = walk(path.join(root, 'web', 'src'), ['.tsx', '.ts']);
  const apiFiles = walk(path.join(root, 'api', 'src'), ['.ts']);

  // --- API routes (method + path) ---
  const routes = [];
  for (const f of apiFiles) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b\w*[Rr]outer\.(get|post|put|patch|delete)\(\s*(['`])([^'`]+)\2/g)) routes.push([m[1].toUpperCase(), norm(m[3])]);
    for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete|use)\(\s*'([^']+)'/g)) routes.push([m[1] === 'use' ? 'ANY' : m[1].toUpperCase(), norm(m[2])]);
  }
  // Routes registered in a loop: `/api/hana/actions/:id/${verb}` for verb of [confirm, cancel].
  for (const v of ['confirm', 'cancel']) routes.push(['POST', `/api/hana/actions/*/${v}`]);
  const hasRoute = (method, p) => routes.some(([m, r]) => (m === method || m === 'ANY') && matches(r, p));

  // --- page routes ---
  const reg = readFileSync(path.join(root, 'web', 'src', 'modules', 'index.tsx'), 'utf8');
  const pages = [...reg.matchAll(/path: '([^']+)'/g)].map((m) => norm(m[1]));
  pages.push('/join/*', '/grocery-list', '/dev-login');
  const hasPage = (p) => pages.some((r) => matches(r, p));

  let buttons = 0;
  let calls = 0;
  let links = 0;
  for (const f of webFiles) {
    const src = readFileSync(f, 'utf8');
    const rel = path.relative(root, f).replace(/\\/g, '/');
    const hasSubmitForm = /<form[^>]*onSubmit=/.test(src);

    // 1. buttons
    for (const m of src.matchAll(/<button\b/g)) {
      buttons++;
      const tag = tagAt(src, m.index);
      const line = src.slice(0, m.index).split('\n').length;
      const ok = /\bonClick=/.test(tag) || /\bonPointerDown=/.test(tag) || (!/type="button"/.test(tag) && hasSubmitForm) || /type="submit"/.test(tag) && hasSubmitForm;
      if (!ok) problems.push(`${rel}:${line} <button> has no handler`);
    }

    // 2. API calls
    // api('/api/x', 'POST') and api(withMember('/api/x', key), 'POST')
    const callRe = /\bapi(?:<[^>]*>)?\(\s*(?:(?:withMember|path)\(\s*(['`])(\/api\/[^'`]*)\1(?:\s*,[^)]*)?\)|(['`])(\/api\/[^'`]*)\3)(?:\s*,\s*'(GET|POST|PUT|PATCH|DELETE)')?/g;
    for (const m of src.matchAll(callRe)) {
      calls++;
      const method = m[5] ?? 'GET';
      const p = norm(m[2] ?? m[4]);
      const line = src.slice(0, m.index).split('\n').length;
      if (!hasRoute(method, p)) problems.push(`${rel}:${line} ${method} ${p} — no such API route`);
    }
    for (const m of src.matchAll(/fetch\(\s*(['`])(\/api\/[^'`]*)\1\s*,\s*\{\s*method:\s*'(\w+)'/g)) {
      calls++;
      if (!hasRoute(m[3], norm(m[2]))) problems.push(`${rel} fetch ${m[3]} ${norm(m[2])} — no such API route`);
    }
    for (const m of src.matchAll(/href=\{?(['`])(\/api\/[^'`]*)\1/g)) {
      calls++;
      if (!hasRoute('GET', norm(m[2]))) problems.push(`${rel} href GET ${norm(m[2])} — no such API route`);
    }

    // 3. in-app links
    for (const m of src.matchAll(/(?:\bto=\{?|nav\(|navigate\()(['`])(\/[^'`]*)\1/g)) {
      links++;
      if (!hasPage(norm(m[2]))) problems.push(`${rel} link ${m[2]} — no such page`);
    }
  }
  return { problems, buttons, calls, links, routes: routes.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = audit();
  console.log(`buttons ${r.buttons} · API calls ${r.calls} · links ${r.links} · API routes ${r.routes}`);
  if (r.problems.length) {
    console.log(r.problems.map((p) => `  DEAD  ${p}`).join('\n'));
    process.exit(1);
  }
  console.log('no dead controls');
}
