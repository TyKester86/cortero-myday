/**
 * The real Plaid client (REST over fetch), PRODUCTION only — MyDay runs real finances (Ty,
 * 2026-10-11). Read-only: the Transactions product (accounts with their balances, and
 * transactions). Nothing here can move money; no payment or transfer endpoint is called, ever.
 * Balances come from /accounts/get (refreshed with transactions; not the separately billed
 * Balance product) and are shown with the time of the last sync.
 */
import type { DateStr } from '@myday/shared';
import { HttpError } from '../http.js';
import type { MoneyProvider, ProviderAccount, ProviderTxn } from './provider.js';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export class PlaidProvider implements MoneyProvider {
  readonly kind = 'plaid' as const;
  private readonly base: string;

  constructor(
    private readonly clientId: string,
    private readonly secret: string,
    /** Where a bank's own sign-in sends the person back (OAuth banks); registered in the Plaid dashboard. */
    private readonly redirectUri: string | null = null,
  ) {
    this.base = 'https://production.plaid.com';
  }

  private async call(path: string, body: Json): Promise<Json> {
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, secret: this.secret, ...body }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok || !isObj(data)) {
      const code = isObj(data) ? s(data.error_code) : '';
      console.error('plaid error', path, res.status, code);
      if (code === 'PRODUCT_NOT_READY') throw new HttpError(409, 'The bank is still preparing transactions — sync again in a minute');
      if (code === 'ITEM_LOGIN_REQUIRED') throw new HttpError(409, 'The bank needs you to sign in again — unlink and relink it');
      throw new HttpError(502, 'The bank connection failed — try again');
    }
    return data;
  }

  async createLinkToken(clientUserId: string): Promise<string> {
    const r = await this.call('/link/token/create', {
      client_name: 'MyDay',
      user: { client_user_id: clientUserId },
      products: ['transactions'],
      transactions: { days_requested: 365 },
      country_codes: ['US'],
      language: 'en',
      ...(this.redirectUri ? { redirect_uri: this.redirectUri } : {}),
    });
    return s(r.link_token);
  }

  async exchange(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const r = await this.call('/item/public_token/exchange', { public_token: publicToken });
    return { accessToken: s(r.access_token), itemId: s(r.item_id) };
  }

  async accounts(accessToken: string): Promise<ProviderAccount[]> {
    const r = await this.call('/accounts/get', { access_token: accessToken });
    const list = Array.isArray(r.accounts) ? r.accounts : [];
    return list.filter(isObj).map((a): ProviderAccount => {
      const b = isObj(a.balances) ? a.balances : {};
      return {
        accountId: s(a.account_id),
        name: s(a.name) || s(a.official_name),
        mask: s(a.mask),
        type: s(a.type),
        subtype: s(a.subtype),
        current: n(b.current),
        available: n(b.available),
        currency: s(b.iso_currency_code) || 'USD',
      };
    });
  }

  async transactions(accessToken: string, start: DateStr, end: DateStr): Promise<ProviderTxn[]> {
    const out: ProviderTxn[] = [];
    for (let offset = 0; offset < 5000; ) {
      const r = await this.call('/transactions/get', {
        access_token: accessToken,
        start_date: start,
        end_date: end,
        options: { count: 500, offset },
      });
      const list = (Array.isArray(r.transactions) ? r.transactions : []).filter(isObj);
      for (const t of list) {
        const pfc = isObj(t.personal_finance_category) ? s(t.personal_finance_category.primary) : '';
        out.push({
          txnId: s(t.transaction_id),
          accountId: s(t.account_id),
          date: s(t.date),
          name: s(t.name),
          merchant: s(t.merchant_name),
          amount: n(t.amount) ?? 0,
          category: pfc,
          pending: t.pending === true,
        });
      }
      offset += list.length;
      const total = n(r.total_transactions) ?? 0;
      if (!list.length || offset >= total) break;
    }
    return out;
  }

  async remove(accessToken: string): Promise<void> {
    await this.call('/item/remove', { access_token: accessToken });
  }
}
