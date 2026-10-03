/**
 * Hana step 4: flight search. Hana finds flights and hands over booking links;
 * she never books or pays. With DUFFEL_API_KEY set she also reads live offers
 * (price, airline, stops, times) from Duffel's offer search; without it she
 * still gives Google Flights and Kayak links already filled in.
 * FLIGHT_STUB=1 (never in production): deterministic offers for tests.
 */
import type { DateStr } from '@myday/shared';
import { config } from '../config.js';
import { HttpError } from './http.js';

export const CABINS = ['economy', 'premium_economy', 'business', 'first'] as const;
export type Cabin = (typeof CABINS)[number];

export interface FlightQuery {
  from: string;
  to: string;
  depart: DateStr;
  return: DateStr | null;
  adults: number;
  cabin: Cabin;
}

export interface FlightOffer {
  airline: string;
  price: string;
  /** One line per direction: "ATL 7:05 AM → LAX 9:10 AM, nonstop". */
  legs: string[];
}

export interface FlightResults {
  offers: FlightOffer[];
  links: { googleFlights: string; kayak: string };
}

const stub = (): boolean => process.env.FLIGHT_STUB === '1' && !config.production;

export function flightLinks(q: FlightQuery): FlightResults['links'] {
  const cabinWords = q.cabin === 'economy' ? '' : ` ${q.cabin.replace('_', ' ')}`;
  const words = `Flights to ${q.to} from ${q.from} on ${q.depart}${q.return ? ` through ${q.return}` : ' one way'}${q.adults > 1 ? ` for ${q.adults} adults` : ''}${cabinWords}`;
  const kayakCabin = { economy: 'e', premium_economy: 'p', business: 'b', first: 'f' }[q.cabin];
  return {
    googleFlights: `https://www.google.com/travel/flights?q=${encodeURIComponent(words)}`,
    kayak: `https://www.kayak.com/flights/${q.from}-${q.to}/${q.depart}${q.return ? `/${q.return}` : ''}${q.adults > 1 ? `/${q.adults}adults` : ''}${q.cabin === 'economy' ? '' : `/${q.cabin === 'premium_economy' ? 'premium' : q.cabin}`}?sort=price_a&fs=cabin=${kayakCabin}`,
  };
}

const clock = (iso: string): string => {
  const [h, m] = iso.slice(11, 16).split(':').map(Number);
  return `${((h ?? 0) % 12) || 12}:${String(m ?? 0).padStart(2, '0')} ${(h ?? 0) < 12 ? 'AM' : 'PM'}`;
};
const stops = (n: number): string => (n === 0 ? 'nonstop' : `${n} stop${n === 1 ? '' : 's'}`);

interface DuffelSegment {
  origin: { iata_code: string };
  destination: { iata_code: string };
  departing_at: string;
  arriving_at: string;
}
interface DuffelOffer {
  total_amount: string;
  total_currency: string;
  owner: { name: string };
  slices: Array<{ segments: DuffelSegment[] }>;
}

function describe(o: DuffelOffer): FlightOffer {
  return {
    airline: o.owner.name,
    price: `${o.total_currency === 'USD' ? '$' : `${o.total_currency} `}${Number(o.total_amount).toFixed(0)}`,
    legs: o.slices.map((s) => {
      const a = s.segments[0];
      const b = s.segments[s.segments.length - 1];
      if (!a || !b) return '';
      const nextDay = b.arriving_at.slice(0, 10) > a.departing_at.slice(0, 10) ? ' (+1 day)' : '';
      return `${a.origin.iata_code} ${clock(a.departing_at)} → ${b.destination.iata_code} ${clock(b.arriving_at)}${nextDay}, ${stops(s.segments.length - 1)}`;
    }),
  };
}

function stubOffers(q: FlightQuery): DuffelOffer[] {
  const seg = (o: string, d: string, day: DateStr, dep: string, arr: string): DuffelSegment => ({ origin: { iata_code: o }, destination: { iata_code: d }, departing_at: `${day}T${dep}:00`, arriving_at: `${day}T${arr}:00` });
  const mk = (owner: string, amount: number, dep: string, arr: string, via: string | null): DuffelOffer => ({
    total_amount: String(amount * q.adults),
    total_currency: 'USD',
    owner: { name: owner },
    slices: [
      { segments: via ? [seg(q.from, via, q.depart, dep, '10:00'), seg(via, q.to, q.depart, '11:00', arr)] : [seg(q.from, q.to, q.depart, dep, arr)] },
      ...(q.return ? [{ segments: [seg(q.to, q.from, q.return, '15:30', '22:45')] }] : []),
    ],
  });
  return [mk('Delta', 412, '07:05', '09:10', null), mk('Spirit', 189, '06:00', '13:40', 'DFW'), mk('United', 455, '18:20', '20:35', null)];
}

/** Cheapest first, at most `limit`. Offers are empty when no search service is set up. */
export async function searchFlights(q: FlightQuery, limit = 3): Promise<FlightResults> {
  const links = flightLinks(q);
  let raw: DuffelOffer[] = [];
  if (stub()) raw = stubOffers(q);
  else if (process.env.DUFFEL_API_KEY) {
    const res = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=15000', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.DUFFEL_API_KEY}`, 'Duffel-Version': 'v2', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        data: {
          slices: [{ origin: q.from, destination: q.to, departure_date: q.depart }, ...(q.return ? [{ origin: q.to, destination: q.from, departure_date: q.return }] : [])],
          passengers: Array.from({ length: q.adults }, () => ({ type: 'adult' })),
          cabin_class: q.cabin,
          max_connections: 1,
        },
      }),
      signal: AbortSignal.timeout(25_000),
    }).catch(() => null);
    const out = res?.ok ? ((await res.json().catch(() => null)) as { data?: { offers?: DuffelOffer[] } } | null) : null;
    raw = out?.data?.offers ?? [];
  }
  const offers = raw
    .filter((o) => o.slices.every((s) => s.segments.length > 0))
    .sort((a, b) => Number(a.total_amount) - Number(b.total_amount))
    .slice(0, limit)
    .map(describe);
  return { offers, links };
}

const IATA = /^[A-Z]{3}$/;
export function checkQuery(q: FlightQuery, today: DateStr): void {
  if (!IATA.test(q.from) || !IATA.test(q.to)) throw new HttpError(400, 'I need airport codes like ATL or LAX');
  if (q.from === q.to) throw new HttpError(400, 'The departure and arrival airports are the same');
  if (q.depart < today) throw new HttpError(400, 'That departure date has already passed');
  if (q.return && q.return < q.depart) throw new HttpError(400, 'The return date is before the departure');
}
