/**
 * C5: Papers (the family's forms and documents) and the household vault. Parents only.
 *
 * POST   /api/papers/upload?name=&photo=1  — a file or a phone photo (raw body); Hana reads it
 * GET    /api/papers                       — documents + the vault (numbers masked)
 * GET    /api/papers/:id/file              — the original
 * PATCH  /api/papers/:id                   — correct what Hana read (or say what a photo is)
 * POST   /api/papers/:id/fill              — Hana drafts the fill-in; it waits for the parent's OK
 * GET    /api/papers/:id/filled            — the approved fill-in, printable, signature left blank
 * POST   /api/papers/:id/done              — signed and sent / handled: its loop closes
 * DELETE /api/papers/:id
 * POST   /api/vault, PUT/DELETE /api/vault/:id, POST /api/vault/:id/reveal (logged)
 */
import express, { Router, type Request } from 'express';
import type { HanaAction } from '@myday/shared';
import { pool } from '../db.js';
import { HttpError, idParam } from '../lib/http.js';
import { self } from '../lib/members.js';
import { logEvent } from '../lib/events.js';
import { kindOf } from './chatFiles.js';
import { addDoc, docFile, getDoc, listDocs, listVault, markDocDone, requireAdultMe, revealVault, saveVault, updateDoc } from '../lib/chief/papers.js';
import { proposeFill } from '../lib/hana.js';

export const papersRouter = Router();
export const papersUploadRouter = Router();

const adult = (req: Request) => {
  const me = self(req);
  requireAdultMe(me);
  return me;
};

papersUploadRouter.post('/api/papers/upload', express.raw({ type: () => true, limit: 10 * 1024 * 1024 }), async (req, res) => {
  const me = adult(req);
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!data.length) throw new HttpError(400, 'Nothing was attached');
  const k = kindOf(data, String(req.headers['content-type'] ?? '').split(';')[0] ?? '');
  if (!k) throw new HttpError(415, 'A photo, a PDF or a text file');
  const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 120) : '';
  const doc = await addDoc(me, { source: req.query.photo === '1' ? 'photo' : 'upload', title: name.replace(/\.[a-z0-9]{2,4}$/i, ''), bytes: data, mime: k.mime });
  res.status(201).json({ doc, papers: await listDocs() });
});

papersRouter.get('/api/papers', async (req, res) => {
  adult(req);
  res.json({ papers: await listDocs(), vault: await listVault() });
});

papersRouter.get('/api/papers/:id/file', async (req, res) => {
  adult(req);
  const f = await docFile(idParam(req.params.id));
  if (!f) throw new HttpError(404, 'This one came by email — there is no file');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', 'inline');
  res.send(f.bytes);
});

papersRouter.patch('/api/papers/:id', async (req, res) => {
  adult(req);
  res.json({ doc: await updateDoc(idParam(req.params.id), req.body as Record<string, unknown>) });
});

papersRouter.post('/api/papers/:id/fill', async (req, res) => {
  const me = adult(req);
  const action: HanaAction = await proposeFill(me, idParam(req.params.id));
  res.json({ action });
});

const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

papersRouter.get('/api/papers/:id/filled', async (req, res) => {
  adult(req);
  const d = await getDoc(idParam(req.params.id));
  if (!d.completion) throw new HttpError(404, 'Not filled in yet');
  const rows = d.completion
    .map((f) => `<tr><th>${esc(f.label)}</th><td>${f.value ? esc(f.value) : /sign/i.test(f.label) ? '<span class="sign"></span>' : '<span class="blank"></span>'}</td></tr>`)
    .join('');
  res.setHeader('Cache-Control', 'private, no-store');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1d1d1b}h1{font-size:1.3rem}table{width:100%;border-collapse:collapse}th{text-align:left;width:40%;padding:.5rem;border-bottom:1px solid #ccc;font-weight:600}td{padding:.5rem;border-bottom:1px solid #ccc}.blank,.sign{display:inline-block;width:100%;border-bottom:1px dashed #888;min-height:1.2em}.sign{border-bottom:1.5px solid #000}small{color:#666}</style></head>
<body><h1>${esc(d.title)}</h1><p><small>Filled in by Hana from what your family keeps in MyDay — check it, fill the blanks, and sign it yourself.</small></p><table>${rows}</table></body></html>`);
});

papersRouter.post('/api/papers/:id/done', async (req, res) => {
  const me = adult(req);
  res.json({ doc: await markDocDone(me, idParam(req.params.id)) });
});

papersRouter.delete('/api/papers/:id', async (req, res) => {
  adult(req);
  const id = idParam(req.params.id);
  await pool.query("DELETE FROM open_loops WHERE source_ref = $1 AND closed_at IS NULL", [`doc:${id}`]);
  const { rowCount } = await pool.query('DELETE FROM documents WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json({ papers: await listDocs() });
});

papersRouter.post('/api/vault', async (req, res) => {
  const me = adult(req);
  res.status(201).json({ vault: await saveVault(me, null, req.body as Record<string, unknown>) });
});

papersRouter.put('/api/vault/:id', async (req, res) => {
  const me = adult(req);
  res.json({ vault: await saveVault(me, idParam(req.params.id), req.body as Record<string, unknown>) });
});

papersRouter.delete('/api/vault/:id', async (req, res) => {
  adult(req);
  const { rowCount } = await pool.query('DELETE FROM vault_items WHERE id = $1', [idParam(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json({ vault: await listVault() });
});

/** The whole number, on a parent's tap — logged (which item, who), never the number itself. */
papersRouter.post('/api/vault/:id/reveal', async (req, res) => {
  const me = adult(req);
  const id = idParam(req.params.id);
  const out = await revealVault(id);
  await logEvent('vault_reveal', { item: id }, me.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
});
