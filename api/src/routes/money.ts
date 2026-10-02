/**
 * Money (grown-ups only, read-only). Link a bank through the provider, sync
 * accounts + the last 120 days of transactions into Postgres, and show
 * balances, safe-to-spend, the subscription radar and the transaction list.
 * Nothing here can move money.
 */
import { Router } from 'express';
import type {
  DateStr,
  LinkTokenResponse,
  MoneyAccount,
  MoneyItem,
  MoneyResponse,
  MoneyTransaction,
} from '@myday/shared';
import { pool, tx } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { HttpError, idParam, int, str } from '../lib/http.js';
import { requireAdult } from '../lib/members.js';
import { decryptToken, encryptToken, moneyProvider, type MoneyProvider } from '../lib/money/provider.js';
import { detectRecurring, safeToSpend, type TxnLite } from '../lib/money/analyze.js';

export const moneyRouter = Router();

const HISTORY_DAYS = 120;

function provider(): MoneyProvider {
  const p = moneyProvider();
  if (!p) throw new HttpError(503, 'Money is not set up on this server yet');
  return p;
}

/** Pull accounts + transactions for one linked item and upsert them. */
async function syncItem(p: MoneyProvider, itemDbId: number, accessToken: string): Promise<void> {
  try {
    const accounts = await p.accounts(accessToken);
    const t = today();
    const txns = await p.transactions(accessToken, addDays(t, -HISTORY_DAYS), t);
    await tx(async (c) => {
      const idMap = new Map<string, number>();
      for (const a of accounts) {
        const { rows } = await c.query<{ id: number }>(
          `INSERT INTO money_accounts (item_id, account_id, name, mask, type, subtype, current, available, currency, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           ON CONFLICT (account_id) DO UPDATE SET name = EXCLUDED.name, mask = EXCLUDED.mask, type = EXCLUDED.type,
             subtype = EXCLUDED.subtype, current = EXCLUDED.current, available = EXCLUDED.available,
             currency = EXCLUDED.currency, updated_at = now()
           RETURNING id`,
          [itemDbId, a.accountId, a.name, a.mask, a.type, a.subtype, a.current, a.available, a.currency],
        );
        const id = rows[0]?.id;
        if (id !== undefined) idMap.set(a.accountId, id);
      }
      for (const x of txns) {
        const acct = idMap.get(x.accountId);
        if (acct === undefined) continue;
        await c.query(
          `INSERT INTO money_transactions (account_id, txn_id, day, name, merchant, amount, category, pending)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (txn_id) DO UPDATE SET day = EXCLUDED.day, name = EXCLUDED.name, merchant = EXCLUDED.merchant,
             amount = EXCLUDED.amount, category = EXCLUDED.category, pending = EXCLUDED.pending`,
          [acct, x.txnId, x.date, x.name, x.merchant, x.amount, x.category, x.pending],
        );
      }
      await c.query("UPDATE money_items SET last_synced_at = now(), sync_error = '' WHERE id = $1", [itemDbId]);
    });
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : 'Sync failed';
    await pool.query('UPDATE money_items SET sync_error = $2 WHERE id = $1', [itemDbId, msg]);
    if (!(e instanceof HttpError)) console.error('money sync failed', e);
  }
}

interface AccountRow {
  id: number;
  name: string;
  mask: string;
  type: string;
  subtype: string;
  current: string | null;
  available: string | null;
  institution: string;
}

interface TxnRow {
  id: number;
  day: DateStr;
  name: string;
  merchant: string;
  amount: string;
  category: string;
  pending: boolean;
  account_name: string;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const toTxn = (r: TxnRow): MoneyTransaction => ({
  id: r.id,
  date: r.day,
  name: r.name,
  merchant: r.merchant,
  amount: Number(r.amount),
  category: r.category,
  pending: r.pending,
  accountName: r.account_name,
});

const TXN_SELECT = `SELECT t.id, t.day::text AS day, t.name, t.merchant, t.amount, t.category, t.pending, a.name AS account_name
  FROM money_transactions t JOIN money_accounts a ON a.id = t.account_id`;

async function moneyView(): Promise<MoneyResponse> {
  const p = moneyProvider();
  const { rows: items } = await pool.query<{ id: number; institution: string; last_synced_at: Date | null; sync_error: string }>(
    'SELECT id, institution, last_synced_at, sync_error FROM money_items ORDER BY id',
  );
  const { rows: accts } = await pool.query<AccountRow>(
    `SELECT a.id, a.name, a.mask, a.type, a.subtype, a.current, a.available, i.institution
       FROM money_accounts a JOIN money_items i ON i.id = a.item_id ORDER BY a.type, a.id`,
  );
  const accounts = accts.map(
    (a): MoneyAccount => ({
      id: a.id,
      name: a.name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      current: num(a.current),
      available: num(a.available),
      institution: a.institution,
    }),
  );
  const t = today();
  const { rows: all } = await pool.query<TxnRow>(`${TXN_SELECT} WHERE t.day >= $1 ORDER BY t.day DESC, t.id DESC`, [
    addDays(t, -HISTORY_DAYS),
  ]);
  const lite: TxnLite[] = all.map((r) => ({ date: r.day, name: r.name, merchant: r.merchant, amount: Number(r.amount), pending: r.pending }));
  const subscriptions = detectRecurring(lite, 'out', t);
  const income = detectRecurring(lite, 'in', t);
  const checking = accounts
    .filter((a) => a.type === 'depository' && a.subtype === 'checking')
    .reduce((s, a) => s + (a.available ?? a.current ?? 0), 0);
  return {
    provider: p?.kind ?? 'none',
    items: items.map(
      (i): MoneyItem => ({
        id: i.id,
        institution: i.institution,
        lastSyncedAt: i.last_synced_at ? i.last_synced_at.toISOString() : null,
        syncError: i.sync_error,
      }),
    ),
    accounts,
    safeToSpend: accounts.length ? safeToSpend(checking, subscriptions, income, t) : null,
    subscriptions,
    income,
    transactions: all.slice(0, 50).map(toTxn),
  };
}

moneyRouter.get('/api/money', async (req, res) => {
  requireAdult(req);
  res.json(await moneyView());
});

moneyRouter.post('/api/money/link-token', async (req, res) => {
  const me = requireAdult(req);
  const p = provider();
  const out: LinkTokenResponse = { provider: p.kind, linkToken: await p.createLinkToken(`member-${me.id}`) };
  res.json(out);
});

/** Finish linking: swap the public token for an access token (stored encrypted), then sync. */
moneyRouter.post('/api/money/exchange', async (req, res) => {
  const me = requireAdult(req);
  const p = provider();
  const b = req.body as Record<string, unknown>;
  const { accessToken, itemId } = await p.exchange(str(b.publicToken, 'publicToken', 300, true));
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO money_items (provider, item_id, access_token_enc, institution, linked_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (item_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc RETURNING id`,
    [p.kind, itemId, encryptToken(accessToken), str(b.institution, 'institution', 80) || 'Bank', me.id],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('item insert returned nothing');
  await syncItem(p, id, accessToken);
  res.status(201).json(await moneyView());
});

moneyRouter.post('/api/money/sync', async (req, res) => {
  requireAdult(req);
  const p = provider();
  const { rows } = await pool.query<{ id: number; access_token_enc: string; provider: string }>(
    'SELECT id, access_token_enc, provider FROM money_items',
  );
  for (const r of rows) {
    if (r.provider !== p.kind) continue; // e.g. fake items once Plaid is configured
    await syncItem(p, r.id, decryptToken(r.access_token_enc));
  }
  res.json(await moneyView());
});

moneyRouter.get('/api/money/transactions', async (req, res) => {
  requireAdult(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  const days = int(req.query.days ?? 60, 'days', 1, HISTORY_DAYS);
  const account = req.query.account ? idParam(req.query.account) : null;
  const { rows } = await pool.query<TxnRow>(
    `${TXN_SELECT}
      WHERE t.day >= $1 AND ($2::int IS NULL OR a.id = $2)
        AND ($3 = '' OR t.name ILIKE '%' || $3 || '%' OR t.merchant ILIKE '%' || $3 || '%')
      ORDER BY t.day DESC, t.id DESC LIMIT 500`,
    [addDays(today(), -days), account, q],
  );
  res.json({ transactions: rows.map(toTxn) });
});

/** Unlink a bank: revoke at the provider, delete its stored accounts + transactions. */
moneyRouter.delete('/api/money/items/:id', async (req, res) => {
  requireAdult(req);
  const id = idParam(req.params.id);
  const { rows } = await pool.query<{ access_token_enc: string; provider: string }>(
    'SELECT access_token_enc, provider FROM money_items WHERE id = $1',
    [id],
  );
  const item = rows[0];
  if (!item) throw new HttpError(404, 'No such bank link');
  const p = moneyProvider();
  if (p && p.kind === item.provider) {
    try {
      await p.remove(decryptToken(item.access_token_enc));
    } catch (e) {
      console.error('money: provider unlink failed (removing locally anyway)', e instanceof HttpError ? e.message : e);
    }
  }
  await pool.query('DELETE FROM money_items WHERE id = $1', [id]);
  res.json(await moneyView());
});
