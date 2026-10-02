import type { GroceryChain } from '@myday/shared';

type Chain = Omit<GroceryChain, 'custom'>;

/** GROCERY_CHAINS from myday-app.gs, verbatim. */
export const GROCERY_CHAINS: Chain[] = [
  { name: 'Walmart', shopUrl: 'https://www.walmart.com/grocery', acctUrl: 'https://www.walmart.com/account', pickup: 'advertised', delivery: 'advertised', note: 'Pickup & delivery advertised nationally' },
  { name: 'Albertsons', shopUrl: 'https://www.albertsons.com', acctUrl: 'https://www.albertsons.com', pickup: 'advertised', delivery: 'advertised', note: 'DriveUp & Go pickup + delivery' },
  { name: 'Kroger', shopUrl: 'https://www.kroger.com', acctUrl: 'https://www.kroger.com/signin', pickup: 'advertised', delivery: 'advertised', note: 'Pickup + delivery via site or app' },
  { name: 'ALDI', shopUrl: 'https://www.instacart.com', acctUrl: 'https://www.instacart.com', pickup: 'advertised', delivery: 'advertised', note: 'Curbside pickup & delivery via Instacart' },
  { name: 'Target', shopUrl: 'https://www.target.com', acctUrl: 'https://www.target.com/account', pickup: 'advertised', delivery: 'advertised', note: 'Grocery pickup + Shipt delivery' },
  { name: 'H-E-B', shopUrl: 'https://www.heb.com', acctUrl: 'https://www.heb.com', pickup: 'advertised', delivery: 'advertised', note: 'Curbside pickup + delivery (Texas)' },
  { name: 'Publix', shopUrl: 'https://www.instacart.com', acctUrl: 'https://www.instacart.com', pickup: 'check', delivery: 'advertised', note: 'Delivery via Instacart (Southeast)' },
  { name: 'Whole Foods Market', shopUrl: 'https://www.wholefoodsmarket.com', acctUrl: 'https://www.amazon.com', pickup: 'check', delivery: 'advertised', note: 'Delivery via Amazon' },
  { name: 'Sprouts Farmers Market', shopUrl: 'https://www.instacart.com', acctUrl: 'https://www.instacart.com', pickup: 'advertised', delivery: 'advertised', note: 'Pickup + delivery via Instacart' },
  { name: 'Costco', shopUrl: 'https://www.costco.com', acctUrl: 'https://www.costco.com/LogonForm', pickup: 'check', delivery: 'advertised', note: 'Same-day delivery via Instacart; membership required' },
  { name: "Sam's Club", shopUrl: 'https://www.samsclub.com', acctUrl: 'https://www.samsclub.com', pickup: 'advertised', delivery: 'advertised', note: 'Pickup + delivery; membership required' },
  { name: 'Dollar General', shopUrl: 'https://www.dollargeneral.com', acctUrl: 'https://www.dollargeneral.com', pickup: 'check', delivery: 'check', note: 'DG Pickup + DG Delivery in select areas' },
  { name: 'Food Lion', shopUrl: 'https://www.foodlion.com', acctUrl: 'https://www.foodlion.com', pickup: 'advertised', delivery: 'advertised', note: 'Pickup + delivery via Instacart' },
  { name: 'Save A Lot', shopUrl: 'https://savealot.com', acctUrl: 'https://savealot.com', pickup: 'check', delivery: 'check', note: 'Availability varies by location' },
  { name: 'Homeland', shopUrl: 'https://homelandstores.com', acctUrl: 'https://homelandstores.com', pickup: 'check', delivery: 'check', note: 'Oklahoma regional chain' },
  { name: "Trader Joe's", shopUrl: 'https://www.traderjoes.com', acctUrl: 'https://www.traderjoes.com', pickup: 'no', delivery: 'no', note: 'In-store only' },
];
