/**
 * LOCAL PROOF ONLY. A deterministic stand-in for Plaid: three accounts and a
 * rolling 120 days of transactions with real-looking recurring patterns
 * (biweekly pay, rent, streaming, gym, a utility bill) plus irregular
 * spending. Same dates always produce the same transaction ids.
 */
import { randomBytes } from 'node:crypto';
import type { DateStr } from '@myday/shared';
import { addDays, daysBetween, today } from '../dates.js';
import { HttpError } from '../http.js';
import type { MoneyProvider, ProviderAccount, ProviderTxn } from './provider.js';

/** Small deterministic PRNG keyed by a string (so a date always gives the same "random" spend). */
function rand(key: string): number {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const PAY_ANCHOR = '2026-01-02'; // a Friday; paid every 14 days

export class FakeProvider implements MoneyProvider {
  readonly kind = 'fake' as const;

  async createLinkToken(): Promise<string> {
    return `link-fake-${randomBytes(6).toString('hex')}`;
  }

  async exchange(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    if (!publicToken.startsWith('public-fake-')) throw new HttpError(400, 'Not a fake public token');
    const id = randomBytes(6).toString('hex');
    return { accessToken: `access-fake-${id}`, itemId: `item-fake-${id}` };
  }

  private ids(accessToken: string): { checking: string; savings: string; card: string } {
    const suffix = accessToken.replace('access-fake-', '');
    return { checking: `chk-${suffix}`, savings: `sav-${suffix}`, card: `cc-${suffix}` };
  }

  async accounts(accessToken: string): Promise<ProviderAccount[]> {
    const id = this.ids(accessToken);
    return [
      { accountId: id.checking, name: 'Everyday Checking', mask: '4821', type: 'depository', subtype: 'checking', current: 2903.55, available: 2840.12, currency: 'USD' },
      { accountId: id.savings, name: 'Rainy Day Savings', mask: '7730', type: 'depository', subtype: 'savings', current: 6200, available: 6200, currency: 'USD' },
      { accountId: id.card, name: 'Rewards Visa', mask: '1188', type: 'credit', subtype: 'credit card', current: 412.9, available: 4587.1, currency: 'USD' },
    ];
  }

  async transactions(accessToken: string, start: DateStr, end: DateStr): Promise<ProviderTxn[]> {
    const id = this.ids(accessToken);
    const out: ProviderTxn[] = [];
    const t = today();
    const add = (date: DateStr, key: string, acct: string, name: string, merchant: string, amount: number, category: string): void => {
      out.push({
        txnId: `fake-${date}-${key}`,
        accountId: acct,
        date,
        name,
        merchant,
        amount: Math.round(amount * 100) / 100,
        category,
        pending: date === t,
      });
    };
    for (let d = start; d <= end && d <= t; d = addDays(d, 1)) {
      const dom = Number(d.slice(8, 10));
      if (daysBetween(PAY_ANCHOR, d) % 14 === 0) add(d, 'pay', id.checking, 'ACME CORP PAYROLL DIR DEP', 'Acme Corp', -2400, 'INCOME');
      if (dom === 1) add(d, 'rent', id.checking, 'OAKWOOD APTS RENT #4471', 'Oakwood Apartments', 1450, 'RENT_AND_UTILITIES');
      if (dom === 5) add(d, 'gym', id.checking, 'PLANET FITNESS CLUB FEES', 'Planet Fitness', 29.99, 'PERSONAL_CARE');
      if (dom === 12) add(d, 'netflix', id.card, 'NETFLIX.COM', 'Netflix', 15.49, 'ENTERTAINMENT');
      if (dom === 20) add(d, 'spotify', id.card, 'SPOTIFY USA', 'Spotify', 11.99, 'ENTERTAINMENT');
      if (dom === 18) add(d, 'power', id.checking, 'OG&E ELECTRIC AUTOPAY', 'OG&E', 104 + Math.round(rand(`power${d}`) * 28), 'RENT_AND_UTILITIES');
      // Irregular spending (not recurring).
      const r = rand(`groc${d}`);
      if (r < 0.28) add(d, 'groc', id.card, 'KROGER #0612', 'Kroger', 60 + r * 400, 'FOOD_AND_DRINK');
      const c = rand(`coffee${d}`);
      if (c < 0.2) add(d, 'coffee', id.card, 'STARBUCKS STORE 1182', 'Starbucks', 4 + c * 30, 'FOOD_AND_DRINK');
      const a = rand(`amzn${d}`);
      if (a < 0.08) add(d, 'amzn', id.card, `AMAZON MKTPL*${Math.floor(a * 1e6)}`, 'Amazon', 12 + a * 700, 'GENERAL_MERCHANDISE');
    }
    return out;
  }

  async remove(): Promise<void> {
    /* nothing to revoke */
  }
}
