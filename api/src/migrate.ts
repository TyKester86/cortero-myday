/**
 * Applies api/migrations/*.sql in filename order, each in its own
 * transaction, recording what ran in schema_migrations. Runs on every deploy
 * (container start) — already-applied files are skipped.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './db.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`migrate: applied ${file}`);
  }
  console.log('migrate: up to date');
}

main()
  .then(() => pool.end())
  .catch(async (e: unknown) => {
    console.error('migrate: FAILED', e);
    await pool.end();
    process.exit(1);
  });
