import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as plain yyyy-MM-dd strings, never JS Dates — every
// date in this app is a household-calendar day, not an instant.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });

export type Db = pg.Pool | pg.PoolClient;

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
