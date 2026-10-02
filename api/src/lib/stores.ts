import type { GroceryChain } from '@myday/shared';

type Chain = Omit<GroceryChain, 'custom'>;

/**
 * GROCERY_CHAINS from myday-app.gs, plus each store's real grocery ordering
 * page (orderUrl; null = in-store only). MyDay never places the order — it
 * opens the store's ordering page with the family's list beside it.
 */
export const GROCERY_CHAINS: Chain[] = [
  { name: 'Walmart', orderUrl: 'https://www.walmart.com/cp/food/976759', shopUrl: 'https://www.walmart.com/grocery', acctUrl: 'https://www.walmart.com/account', pickup: 'advertised', delivery: 'advertised', note: 'Pickup & delivery advertised nationally' },
  { name: 'Albertsons', orderUrl: 'https://www.albertsons.com/shop/aisles.html', shopUrl: 'https://www.albertsons.com', acctUrl: 'https://www.albertsons.com', pickup: 'advertised', delivery: 'advertised', note: 'DriveUp & Go pickup + delivery' },
  { name: 'Kroger', orderUrl: 'https://www.kroger.com/', shopUrl: 'https://www.kroger.com', acctUrl: 'https://www.kroger.com/signin', pickup: 'advertised', delivery: 'advertised', note: 'Pickup + delivery via site or app' },
  { name: 'ALDI', orderUrl: 'https://www.aldi.us/store/aldi/storefront', shopUrl: 'https://www.instacart.com', acctUrl: 'https://www.instacart.com', pickup: 'advertised', delivery: 'advertised', note: 'Curbside pickup & delivery via Instacart' },
  { name: 'Target', orderUrl: 'https://www.target.com/c/grocery/-/N-5xt1a', shopUrl: 'https://www.target.com', acctUrl: 'https://www.target.com/account', pickup: 'advertised', delivery: 'advertised', note: 'Grocery pickup + Shipt delivery' },
  { name: 'H-E-B', orderUrl: 'https://www.heb.com/category/shop/490020', shopUrl: 'https://www.heb.com', acctUrl: 'https://www.heb.com', pickup: 'advertised', delivery: 'advertised', note: 'Curbside pickup + delivery (Texas)' },
  { name: 'Publix', orderUrl: 'https://delivery.publix.com/store/publix/storefront', shopUrl: 'https://www.instacart.com', acctUrl: 'https://www.instacart.com', pickup: 'check', delivery: 'advertised', note: 'Delivery via Instacart (Southeast)' },
  { name: 'Whole Foods Market', orderUrl: 'https://www.amazon.com/alm/storefront?almBrandId=VUZHIFdob2xlIEZvb2Rz', shopUrl: 'https://www.wholefoodsmarket.com', acctUrl: 'https://www.amazon.com', pickup: 'check', delivery: 'advertised', note: 'Delivery via Amazon' },
  { name: 'Sprouts Farmers Market', orderUrl: 'https://shop.sprouts.com/store/sprouts/storefront', shopUrl: 'https://www.instacart.com', acctUrl: 'https://www.instacart.com', pickup: 'advertised', delivery: 'advertised', note: 'Pickup + delivery via Instacart' },
  { name: 'Costco', orderUrl: 'https://sameday.costco.com/', shopUrl: 'https://www.costco.com', acctUrl: 'https://www.costco.com/LogonForm', pickup: 'check', delivery: 'advertised', note: 'Same-day delivery via Instacart; membership required' },
  { name: "Sam's Club", orderUrl: 'https://www.samsclub.com/c/grocery/1444', shopUrl: 'https://www.samsclub.com', acctUrl: 'https://www.samsclub.com', pickup: 'advertised', delivery: 'advertised', note: 'Pickup + delivery; membership required' },
  { name: 'Dollar General', orderUrl: 'https://www.dollargeneral.com/', shopUrl: 'https://www.dollargeneral.com', acctUrl: 'https://www.dollargeneral.com', pickup: 'check', delivery: 'check', note: 'DG Pickup + DG Delivery in select areas' },
  { name: 'Food Lion', orderUrl: 'https://www.foodlion.com/', shopUrl: 'https://www.foodlion.com', acctUrl: 'https://www.foodlion.com', pickup: 'advertised', delivery: 'advertised', note: 'Pickup + delivery via Instacart' },
  { name: 'Save A Lot', orderUrl: 'https://savealot.com/', shopUrl: 'https://savealot.com', acctUrl: 'https://savealot.com', pickup: 'check', delivery: 'check', note: 'Availability varies by location' },
  { name: 'Homeland', orderUrl: 'https://homelandstores.com/', shopUrl: 'https://homelandstores.com', acctUrl: 'https://homelandstores.com', pickup: 'check', delivery: 'check', note: 'Oklahoma regional chain' },
  { name: "Trader Joe's", orderUrl: null, shopUrl: 'https://www.traderjoes.com', acctUrl: 'https://www.traderjoes.com', pickup: 'no', delivery: 'no', note: 'In-store only' },
];
