#!/usr/bin/env node
/**
 * Backup + restore drill. Proves deploy/backup.sh and deploy/restore.sh end to end:
 *
 *   1. back up a real MyDay database as the ordinary app role (FORCE row-level
 *      security in effect, exactly like the droplet), encrypted;
 *   2. ship it to S3-compatible storage (a local S3 mock container stands in for
 *      DigitalOcean Spaces);
 *   3. delete the local copy (the droplet is gone), restore from the bucket
 *      into a scratch database;
 *   4. compare row counts of EVERY table, and check the restored database
 *      still enforces row-level security and the append-only events log.
 *
 * Needs Docker and a Postgres reachable from containers.
 *   DRILL_ADMIN_URL   superuser URL (as seen from this machine)
 *   DRILL_SOURCE_DB   database to back up (default myday_e2e)
 *   DRILL_APP_ROLE    owner role used for the dump (default myday_e2e_app)
 *   DRILL_DOCKER_HOST host name containers use to reach Postgres (default host.docker.internal)
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const admin = new URL(process.env.DRILL_ADMIN_URL ?? '');
if (!admin.host) throw new Error('Set DRILL_ADMIN_URL (superuser Postgres URL)');
const SOURCE = process.env.DRILL_SOURCE_DB ?? 'myday_e2e';
const SCRATCH = 'myday_restore_drill';
const ROLE = process.env.DRILL_APP_ROLE ?? 'myday_e2e_app';
const DHOST = process.env.DRILL_DOCKER_HOST ?? 'host.docker.internal';
const work = path.join(os.tmpdir(), `myday-drill-${Date.now()}`).replace(/\\/g, '/');
const minioName = `myday-drill-s3-${process.pid}`;
const S3 = { key: 'drill', secret: randomBytes(16).toString('hex'), bucket: 'myday-backups' };

const url = (db, user = admin.username, pw = decodeURIComponent(admin.password), host = DHOST) =>
  `postgresql://${user}:${encodeURIComponent(pw)}@${host}:${admin.port}/${db}`;
const q = async (db, sql, params = []) => {
  const c = new pg.Client({ connectionString: url(db, undefined, undefined, admin.hostname) });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { env: { ...process.env, MSYS_NO_PATHCONV: '1', ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function counts(db) {
  const tables = (await q(db, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'session' ORDER BY 1")).map((r) => r.tablename);
  const out = {};
  for (const t of tables) out[t] = (await q(db, `SELECT count(*)::int AS n FROM "${t}"`))[0].n;
  return out;
}

try {
  mkdirSync(work, { recursive: true });
  const key = path.join(work, 'backup.key');
  writeFileSync(key, randomBytes(48).toString('base64'), { mode: 0o600 });
  const rolePw = randomBytes(18).toString('hex');
  await q('postgres', `ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${rolePw}'`);

  console.log('== start S3 stand-in (adobe/s3mock)');
  run('docker', ['run', '-d', '--rm', '--name', minioName, '-p', '9100:9090', '-e', `COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=${S3.bucket}`, 'adobe/s3mock']);
  const s3env = {
    BACKUP_S3_BUCKET: S3.bucket, BACKUP_S3_ENDPOINT: `http://${DHOST}:9100`, BACKUP_S3_KEY: S3.key, BACKUP_S3_SECRET: S3.secret,
    BACKUP_S3_PREFIX: 'myday',
  };
  for (let i = 0; i < 60; i++) {
    const r = spawnSync('docker', ['run', '--rm', '-e', `AWS_ACCESS_KEY_ID=${S3.key}`, '-e', `AWS_SECRET_ACCESS_KEY=${S3.secret}`, '-e', 'AWS_DEFAULT_REGION=us-east-1',
      'amazon/aws-cli', '--endpoint-url', s3env.BACKUP_S3_ENDPOINT, 's3', 'ls', `s3://${S3.bucket}`], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (r.status === 0) break;
    await new Promise((res) => setTimeout(res, 1000));
  }

  console.log('== 1. back up (as the app role, RLS forced) → encrypt → ship');
  const before = await counts(SOURCE);
  const common = { ENV_FILE: path.join(work, 'none.env'), BACKUP_KEY_FILE: key, BACKUP_DIR: path.join(work, 'backups').replace(/\\/g, '/'), BACKUP_DOCKER_NETWORK: 'bridge' };
  const out = run('bash', [path.join(root, 'deploy', 'backup.sh')], { ...common, ...s3env, DATABASE_URL: url(SOURCE, ROLE, rolePw) });
  const name = out.match(/wrote (myday-\S+\.dump\.enc)/)?.[1];
  check('backup written and shipped off-box', !!name && /shipped to s3:\/\//.test(out), name);
  const local = readdirSync(common.BACKUP_DIR);
  check('encrypted at rest (no plaintext PGDMP header)', !run('bash', ['-c', `head -c 5 "${common.BACKUP_DIR}/${name}"`]).startsWith('PGDMP'));
  const noS3 = spawnSync('bash', [path.join(root, 'deploy', 'backup.sh')], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', ...common, DATABASE_URL: url(SOURCE, ROLE, rolePw) } });
  check('without a bucket it refuses to report success (exit 2)', noS3.status === 2, `exit ${noS3.status}`);

  console.log('== 2. lose the droplet copy, restore from the bucket into a scratch database');
  rmSync(common.BACKUP_DIR, { recursive: true, force: true });
  check('local copies deleted', local.length >= 2);
  await q('postgres', `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await q('postgres', `CREATE DATABASE ${SCRATCH} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
  const live = spawnSync('bash', [path.join(root, 'deploy', 'restore.sh'), `s3:${name}`, url(SOURCE)], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', ...common, ...s3env, DATABASE_URL: url(SOURCE) } });
  check('restoring over the live database is refused', live.status === 1 && /LIVE/.test(live.stderr));
  const rout = run('bash', [path.join(root, 'deploy', 'restore.sh'), `s3:${name}`, url(SCRATCH)], { ...common, ...s3env });
  check('downloaded, checksum verified, restored', /checksum ok/.test(rout) && /restored/.test(rout), rout.trim().split('\n').slice(-4).join(' · '));

  console.log('== 3. prove it');
  const after = await counts(SCRATCH);
  const diff = Object.keys(before).filter((t) => before[t] !== after[t]);
  check(`every table matches (${Object.keys(before).length} tables, ${Object.values(before).reduce((a, b) => a + b, 0)} rows)`, diff.length === 0, diff.map((t) => `${t} ${before[t]}→${after[t]}`).join(', '));
  const rls = await q(SCRATCH, "SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'r' AND relforcerowsecurity");
  check('row-level security still forced on the restored tables', rls[0].n >= 40, `${rls[0].n} tables`);
  let blocked = false;
  try {
    await q(SCRATCH, 'DELETE FROM events');
  } catch {
    blocked = true;
  }
  check('append-only events log still enforced', blocked);
} finally {
  spawnSync('docker', ['rm', '-f', minioName], { encoding: 'utf8' });
  await q('postgres', `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`).catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
const ok = checks.every(Boolean);
console.log(ok ? '\nRESTORE DRILL PASSED' : '\nRESTORE DRILL FAILED');
process.exit(ok ? 0 : 1);
