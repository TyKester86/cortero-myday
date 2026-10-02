/**
 * Database access, scoped per household.
 *
 * Every family-owned table has a household_id and Postgres row-level
 * security (migration 004): a connection only ever sees and writes rows of
 * the household set in `app.household_id`. Each API request runs on its own
 * connection (AsyncLocalStorage), tagged with the signed-in user's household,
 * so ordinary queries need no WHERE household_id = ... and can't leak across
 * families even if a query forgets.
 *
 * `asSystem()` lifts the restriction for the few cross-household lookups
 * (sign-in by email, invite links, kid devices, migrations, the CLI).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as plain yyyy-MM-dd strings, never JS Dates — every
// date in this app is a household-calendar day, not an instant.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);

/** The raw pool. Use only for things outside household data (session store). */
export const rawPool = new pg.Pool({ connectionString: config.databaseUrl, max: 12 });

interface Scope {
  client: pg.PoolClient;
  householdId: number | null;
  system: boolean;
}

const als = new AsyncLocalStorage<Scope>();

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export type Db = Queryable;

async function configure(c: pg.PoolClient, householdId: number | null, system: boolean): Promise<void> {
  await c.query("SELECT set_config('app.household_id', $1, false), set_config('app.system', $2, false)", [
    householdId === null ? '' : String(householdId),
    system ? 'on' : 'off',
  ]);
}

/** Queries go to the current scope's connection (or the raw pool, which sees no household rows). */
export const pool: Queryable & { end(): Promise<void> } = {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    const s = als.getStore();
    return s ? s.client.query<R>(text, values) : rawPool.query<R>(text, values);
  },
  end: () => rawPool.end(),
};

/**
 * Run `fn` with a given household scope. Nested calls reuse the current
 * connection and restore the outer scope afterwards.
 */
export async function runScoped<T>(householdId: number | null, system: boolean, fn: () => Promise<T>): Promise<T> {
  const outer = als.getStore();
  if (outer) {
    const prev = { householdId: outer.householdId, system: outer.system };
    await configure(outer.client, householdId, system);
    outer.householdId = householdId;
    outer.system = system;
    try {
      return await fn();
    } finally {
      await configure(outer.client, prev.householdId, prev.system);
      outer.householdId = prev.householdId;
      outer.system = prev.system;
    }
  }
  const client = await rawPool.connect();
  try {
    await configure(client, householdId, system);
    return await als.run({ client, householdId, system }, fn);
  } finally {
    await configure(client, null, false).catch(() => undefined);
    client.release();
  }
}

/** Cross-household access (sign-in lookups, invite links, migrations, CLI). */
export const asSystem = <T>(fn: () => Promise<T>): Promise<T> => runScoped(null, true, fn);
export const inHousehold = <T>(householdId: number, fn: () => Promise<T>): Promise<T> => runScoped(householdId, false, fn);

/** Switch the current request's scope to a household (after sign-in is resolved). */
export async function setHousehold(householdId: number | null): Promise<void> {
  const s = als.getStore();
  if (!s) throw new Error('setHousehold outside a request scope');
  await configure(s.client, householdId, false);
  s.householdId = householdId;
  s.system = false;
}

export function currentHousehold(): number | null {
  return als.getStore()?.householdId ?? null;
}

/**
 * Express middleware: give this request its own connection for its whole
 * life, starting with no household (sees nothing) until sign-in sets one.
 */
export function requestScope(_req: unknown, res: { on(ev: string, fn: () => void): void }, next: (err?: unknown) => void): void {
  rawPool
    .connect()
    .then(async (client) => {
      await configure(client, null, false);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        configure(client, null, false)
          .catch(() => undefined)
          .finally(() => client.release());
      };
      res.on('finish', release);
      res.on('close', release);
      als.run({ client, householdId: null, system: false }, () => next());
    })
    .catch(next);
}

/**
 * Run work after the response, outside the request's connection (which is
 * released when the response ends). The job opens its own scope.
 */
export function detached(fn: () => Promise<void>): void {
  als.exit(() => {
    setImmediate(() => {
      fn().catch((e: unknown) => console.error('background job failed', e instanceof Error ? e.message : e));
    });
  });
}

/** A transaction on the current scope's connection (or a fresh one outside requests). */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const s = als.getStore();
  const client = s?.client ?? (await rawPool.connect());
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    if (!s) client.release();
  }
}
