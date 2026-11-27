import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createSystemRuntime } from '../src/cli.ts';
import { createConfig } from '../src/config.ts';
import type { ArbitrageConfig } from '../src/config.ts';
import { seedCanonicalCatalog } from '../src/catalog/seed.ts';
import { ArbitrageDatabase } from '../src/db/database.ts';
import { fetchWithBackoff, TokenBucketRateLimiter } from '../src/connectors/base.ts';
import type { FetchLike } from '../src/connectors/base.ts';
import { EbayBrowseConnector } from '../src/connectors/ebayConnector.ts';
import {
  BestBuyApiConnector, CostcoConnector, PokemonCenterConnector, ShopifyStorefrontConnector, TcgplayerFeedConnector,
} from '../src/connectors/retailerConnectors.ts';
import { MockScenarioConnector } from '../src/connectors/mockScenarioConnector.ts';
import { RiskEngine } from '../src/decision/riskEngine.ts';
import { percentOfCents } from '../src/domain/money.ts';
import type { ArbitrageDecision, CanonicalSku, RawListing } from '../src/domain/types.ts';
import { EbayOrderApiExecutor, ExecutionCoordinator, ShadowExecutor, SimulatedApiExecutor } from '../src/execution/executor.ts';
import type { ExecutionAdapter } from '../src/execution/executor.ts';
import { EntityResolver } from '../src/matching/entityResolver.ts';
import { WebhookNotifier } from '../src/notifications/notifier.ts';
import { FmvEngine } from '../src/valuation/fmvEngine.ts';

function fixture(t: TestContext) {
  const db = new ArbitrageDatabase(':memory:');
  t.after(() => db.close());
  seedCanonicalCatalog(db);
  const sku = db.getSku('sealed-ssp-bb');
  assert.ok(sku);
  return { db, sku };
}

function testLimiter(): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter({ capacity: 100, refillPerSecond: 100 });
}

test('token bucket deducts tokens and waits for the shortfall', async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = new TokenBucketRateLimiter({
    capacity: 2, refillPerSecond: 4, nowFn: () => now,
    sleepFn: async ms => { waits.push(ms); now += ms; },
  });
  await limiter.acquire(2);
  await Promise.all([limiter.acquire(), limiter.acquire()]);
  now += 5000;
  await limiter.acquire(2);
  await assert.rejects(limiter.acquire(3), RangeError);
  assert.deepEqual(waits, [250, 250]);
});

test('fetch retries 429 using seconds and then 5xx using jittered backoff', async () => {
  const statuses = [429, 503, 200];
  const waits: number[] = [];
  const fetchFn: FetchLike = async () => new Response(null, {
    status: statuses.shift(), headers: { 'Retry-After': '2' },
  });
  const response = await fetchWithBackoff('https://example.test/items', {}, {
    fetchFn, baseDelayMs: 100, sleepFn: async ms => { waits.push(ms); },
  });
  assert.equal(response.status, 200);
  assert.equal(waits[0], 2000);
  assert.ok(waits[1] >= 100 && waits[1] <= 200);
  assert.equal(waits.length, 2);
});

test('fetch handles an HTTP-date Retry-After and reports exhausted retries without query secrets', async t => {
  const now = new Date('2026-11-26T12:00:00Z');
  t.mock.method(Date, 'now', () => now.getTime());
  const waits: number[] = [];
  const fetchFn: FetchLike = async () => new Response(null, {
    status: 429, headers: { 'Retry-After': 'Thu, 26 Nov 2026 12:00:03 GMT' },
  });
  await assert.rejects(
    fetchWithBackoff('https://example.test/?apiKey=secret', {}, {
      maxRetries: 1, fetchFn, sleepFn: async ms => { waits.push(ms); },
    }),
    { message: 'GET https://example.test returned HTTP 429 after 2 attempt(s)' },
  );
  assert.deepEqual(waits, [3000]);
});

test('eBay Browse sends the sanctioned search and maps USD summaries once per item ID', async t => {
  const { db, sku } = fixture(t);
  const secondSku = db.getSku('sealed-pre-etb');
  assert.ok(secondSku);
  const queries: string[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    queries.push(url.searchParams.get('q') ?? '');
    assert.equal(url.pathname, '/buy/browse/v1/item_summary/search');
    assert.equal(url.searchParams.get('filter'), 'buyingOptions:{FIXED_PRICE}');
    assert.equal(url.searchParams.get('sort'), 'newlyListed');
    assert.equal(url.searchParams.get('limit'), '4');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer browse-token');
    assert.equal(new Headers(init?.headers).get('X-EBAY-C-MARKETPLACE-ID'), 'EBAY_US');
    const summary = {
      itemId: 'v1|123|0', title: sku.name, itemWebUrl: 'https://www.ebay.com/itm/123',
      price: { value: '95.99', currency: 'USD' },
      shippingOptions: [{ shippingCost: { value: '5.25', currency: 'USD' } }],
      image: { imageUrl: 'https://images.example.test/front.jpg' },
      additionalImages: [{ imageUrl: 'https://images.example.test/back.jpg' }],
      seller: { username: 'store', feedbackScore: 840, feedbackPercentage: '99.7' },
      condition: 'Near Mint', gtin: sku.upc, epid: '12345', itemCreationDate: '2026-11-25T12:00:00Z',
    };
    return Response.json({ itemSummaries: [summary, {
      ...summary, itemId: 'cad', price: { value: '90.00', currency: 'CAD' },
    }] });
  };
  const connector = new EbayBrowseConnector({
    accessToken: 'browse-token', limitPerQuery: 4, fetchFn, rateLimiter: testLimiter(),
  });
  assert.equal(connector.isEnabled(), true);
  assert.equal(connector.supportsAutoCheckout, true);
  const listings = await connector.fetchListings([sku, secondSku]);
  assert.deepEqual(queries, [sku.name, secondSku.name]);
  assert.equal(listings.length, 1);
  const [listing] = listings;
  assert.equal(listing.listingId, 'v1|123|0');
  assert.equal(listing.priceCents, 9599);
  assert.equal(listing.shippingCents, 525);
  assert.equal(listing.upc, sku.upc);
  assert.equal(listing.conditionHint, 'NM');
  assert.equal(listing.seller.feedbackScore, 840);
  assert.equal(listing.seller.positivePercent, 99.7);
  assert.equal(listing.metadata?.epid, '12345');
  assert.equal(listing.listedAt, '2026-11-25T12:00:00.000Z');
  assert.equal(listing.imageUrls.length, 2);
});

test('Best Buy queries sealed UPCs and returns only available products with usable prices', async t => {
  const { db, sku } = fixture(t);
  const secondSku = db.getSku('sealed-pre-etb');
  const rawSku = db.getSku('raw-en-sv3pt5-199');
  assert.ok(secondSku && rawSku);
  const fetchFn: FetchLike = async input => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.bestbuy.com');
    assert.equal(decodeURIComponent(url.pathname), `/v1/products(upc in(${sku.upc},${secondSku.upc}))`);
    assert.equal(url.searchParams.get('apiKey'), 'api-key');
    assert.equal(url.searchParams.get('format'), 'json');
    const product = { upc: sku.upc, name: sku.name, url: 'https://www.bestbuy.com/site/1' };
    return Response.json({ products: [
      { ...product, sku: 1, onlineAvailability: true, salePrice: 95.25, regularPrice: 149.99 },
      { ...product, sku: 2, upc: secondSku.upc, onlineAvailability: true, regularPrice: 54.99 },
      { ...product, sku: 3, onlineAvailability: false, salePrice: 49.99 },
    ] });
  };
  const connector = new BestBuyApiConnector({ apiKey: 'api-key', fetchFn, rateLimiter: testLimiter() });
  const listings = await connector.fetchListings([sku, secondSku, rawSku]);
  assert.deepEqual(listings.map(listing => [listing.listingId, listing.priceCents]), [['1', 9525], ['2', 5499]]);
  assert.ok(listings.every(listing => listing.source === 'bestbuy' && !listing.supportsAutoCheckout));
  assert.equal(listings[0].seller.feedbackScore, 10_000);
});

async function assertRetailerReview(db: ArbitrageDatabase, listing: RawListing, sku: CanonicalSku, anomaly: boolean) {
  const config = createConfig({ maxAnomalyDiscount: 0.60 });
  db.setOperatingMode('live');
  const match = await new EntityResolver({ config }).resolve(listing, db.listSkus());
  assert.equal(match.status, 'matched');
  assert.equal(match.skuId, sku.id);
  assert.equal(match.matchedCondition, 'SEALED');
  assert.equal(match.sellerTrust.trusted, true);
  const valuation = new FmvEngine().evaluate(sku, db.getSoldComps(sku.id), config);
  const decision = new RiskEngine().decide({
    listing, match, valuation, config, portfolio: db.getPortfolioSnapshot(config), systemState: db.getSystemState(),
  });
  assert.equal(decision.action, 'hitl_review');
  assert.equal(decision.intendedAction, 'hitl_review');
  assert.equal(decision.anomalyFlagged, anomaly);
  assert.ok(decision.warnings.some(warning => /sanctioned automated checkout/.test(warning)));
  assert.equal(decision.warnings.some(warning => /anomaly/i.test(warning)), anomaly);
}

test('Costco filters authorized warehouse items and returns trusted manual checkout leads', async t => {
  const { db } = fixture(t);
  const sku = db.getSku('sealed-151-costco-bundle');
  assert.ok(sku);
  const item = {
    itemNumber: 151500, title: 'Scarlet & Violet 151 Mini Tins 5-Pack', upc: sku.upc,
    url: 'https://www.costco.com/card-bundle.html', price: '37.99', limitPerMember: 2,
  };
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('warehouseId'), '0123');
    assert.equal(url.searchParams.get('category'), 'toys');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer costco-key');
    assert.equal(init?.redirect, 'error');
    return Response.json({ items: [
      item,
      { ...item, itemNumber: 'brand-match', upc: undefined, brand: 'Pokémon', warehouseId: '0456', shippingCents: 299 },
      { ...item, itemNumber: 'category-match', upc: undefined, category: 'Pokemon Trading Cards', priceCents: 4050 },
      { ...item, itemNumber: 'title-match', upc: undefined, title: 'Pokémon 151 Mini Tins 5-Pack' },
      { ...item, itemNumber: 'non-pokemon', upc: undefined },
      { ...item, itemNumber: 'unavailable', inStock: false, onlineAvailable: true },
      { ...item, itemNumber: 'pickup-only', onlineAvailable: false },
      { ...item, itemNumber: 'insecure', url: 'http://www.costco.com/item' },
      { ...item, itemNumber: 'credentials', url: 'https://checkout:secret@www.costco.com/item' },
      { ...item, itemNumber: 'invalid-url', url: '/item' },
      { ...item, itemNumber: 'free', price: 0 },
      { ...item, itemNumber: 'negative', priceCents: -1 },
    ] });
  };
  const connector = new CostcoConnector({
    feedUrl: 'https://feed.example.test/costco?category=toys', apiKey: 'costco-key', warehouseId: '0123', fetchFn,
  });
  assert.equal(connector.isEnabled(), true);
  assert.equal(connector.pollIntervalMs, 60_000);
  const listings = await connector.fetchListings(db.listSkus());
  assert.deepEqual(listings.map(listing => [listing.listingId, listing.priceCents, listing.shippingCents]), [
    ['151500', 3799, 0], ['brand-match', 3799, 299], ['category-match', 4050, 0], ['title-match', 3799, 0],
  ]);
  const [listing, brandMatch] = listings;
  assert.equal(listing.source, 'costco');
  assert.equal(listing.url, item.url);
  assert.equal(listing.supportsAutoCheckout, false);
  assert.deepEqual(listing.seller, {
    sellerId: 'costco-wholesale', username: 'Costco Wholesale', feedbackScore: 10_000, positivePercent: 99.9,
    accountAgeDays: 3650, returnsAccepted: true,
  });
  assert.deepEqual(listing.metadata, { itemNumber: 151500, warehouseId: '0123', limitPerMember: 2, membershipRequired: true });
  assert.equal(brandMatch.metadata?.warehouseId, '0456');
  await assertRetailerReview(db, listing, sku, false);
});

test('Pokémon Center accepts in-stock items and preorders and flags the exclusive ETB discount for review', async t => {
  const { db } = fixture(t);
  const sku = db.getSku('sealed-pre-pc-etb');
  assert.ok(sku);
  const product = {
    title: sku.name, url: 'https://www.pokemoncenter.com/product/pre-etb',
    priceCents: 5999, upc: sku.upc, exclusive: true, purchaseLimit: 1,
  };
  const fetchFn: FetchLike = async (input, init) => {
    assert.equal(String(input), 'https://feed.example.test/pokemon-center');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer pc-key');
    assert.equal(headers.get('X-Pokemon-Center-Region'), 'US');
    assert.equal(init?.redirect, 'error');
    return Response.json({ products: [
      { ...product, productSku: 'pre-etb', availability: 'preorder' },
      { ...product, sku: 'stock', availability: 'in_stock' },
      { ...product, sku: 'available', available: true },
      { ...product, sku: 'missing-availability' },
      { ...product, sku: 'unavailable', available: false, availability: 'preorder' },
      { ...product, sku: 'out', available: true, availability: 'out_of_stock' },
      { ...product, sku: 'sold-out', availability: 'sold_out' },
      { ...product, sku: 'http', available: true, url: 'http://www.pokemoncenter.com/product/pre-etb' },
      { ...product, sku: 'credentials', available: true, url: 'https://:secret@www.pokemoncenter.com/product/pre-etb' },
      { ...product, sku: 'invalid-url', available: true, url: 'not a URL' },
      { ...product, sku: 'fractional', available: true, priceCents: 5999.5 },
      { ...product, sku: 'string-cents', available: true, priceCents: '5999' },
      { ...product, sku: 'free', available: true, priceCents: 0 },
    ] });
  };
  const connector = new PokemonCenterConnector({
    feedUrl: 'https://feed.example.test/pokemon-center', apiKey: 'pc-key', region: 'US', fetchFn,
  });
  assert.equal(connector.isEnabled(), true);
  assert.equal(connector.pollIntervalMs, 45_000);
  const listings = await connector.fetchListings(db.listSkus());
  assert.deepEqual(listings.map(listing => listing.listingId), ['pre-etb', 'stock', 'available']);
  const [listing] = listings;
  assert.equal(listing.source, 'pokemon_center');
  assert.equal(listing.url, product.url);
  assert.equal(listing.priceCents, 5999);
  assert.equal(listing.supportsAutoCheckout, false);
  assert.deepEqual(listing.seller, {
    sellerId: 'pokemon-center', username: 'Pokémon Center', feedbackScore: 10_000, positivePercent: 99.9,
    accountAgeDays: 3650, returnsAccepted: true,
  });
  assert.deepEqual(listing.metadata, {
    productSku: 'pre-etb', exclusive: true, availability: 'preorder', purchaseLimit: 1, region: 'US',
  });
  await assertRetailerReview(db, listing, sku, true);
});

test('Costco and Pokémon Center reject invalid, insecure, or credentialed feed URLs', () => {
  for (const feedUrl of ['invalid', 'http://feed.example.test', 'https://user@feed.example.test', 'https://:secret@feed.example.test']) {
    assert.throws(() => new CostcoConnector({ feedUrl }), /COSTCO_FEED_URL must be an HTTPS URL/);
    assert.throws(() => new PokemonCenterConnector({ feedUrl }), /POKEMON_CENTER_FEED_URL must be an HTTPS URL/);
  }
});

test('live runtime enables retailer feeds from environment settings and accepts alternate array names', async t => {
  const settings = {
    COSTCO_FEED_URL: 'https://feed.example.test/costco', COSTCO_API_KEY: '', COSTCO_WAREHOUSE_ID: '0123',
    POKEMON_CENTER_FEED_URL: 'https://feed.example.test/pokemon-center', POKEMON_CENTER_API_KEY: '',
    POKEMON_CENTER_REGION: '',
  };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  t.mock.method(globalThis, 'fetch', (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), null);
    if (url.pathname === '/costco') {
      assert.equal(url.searchParams.get('warehouseId'), '0123');
      return Response.json({ products: [
        { itemNumber: '123', title: 'Pokemon TCG 151 Mini Tin Bundle', url: 'https://www.costco.com/item', priceCents: 3799 },
      ] });
    }
    assert.equal(url.href, settings.POKEMON_CENTER_FEED_URL);
    assert.equal(headers.get('X-Pokemon-Center-Region'), 'US');
    return Response.json({ items: [{
      productSku: '456', title: 'Pokémon Center ETB', url: 'https://www.pokemoncenter.com/product/456',
      priceCents: 5999, available: true,
    }] });
  });
  const runtime = createSystemRuntime({ dbPath: ':memory:' });
  t.after(() => runtime.db.close());
  const connectors = runtime.connectors.filter(connector => connector.source === 'costco' || connector.source === 'pokemon_center');
  assert.deepEqual(connectors.filter(connector => connector.isEnabled()).map(connector => connector.source), ['costco', 'pokemon_center']);
  const listings = await Promise.all(connectors.map(connector => connector.fetchListings([])));
  assert.deepEqual(listings.map(items => items.map(item => item.listingId)), [['123'], ['456']]);
});

test('Shopify filters authorized feed variants by game and availability', async t => {
  const { sku } = fixture(t);
  const fetchFn: FetchLike = async input => {
    assert.equal(String(input), 'https://cards.example.test/products.json?limit=250');
    return Response.json({ products: [{
      title: 'Pokémon Surging Sparks', handle: 'surging-sparks',
      images: [{ src: 'https://images.example.test/display.jpg' }],
      variants: [
        { id: 1, title: 'Booster Box', available: true, price: '120.99', barcode: sku.upc },
        { id: 2, title: 'Booster Pack', available: false, price: '5.99' },
      ],
    }, {
      title: 'Magic Booster Box', handle: 'mtg',
      variants: [{ id: 3, available: true, price: '100.00' }],
    }] });
  };
  const connector = new ShopifyStorefrontConnector({ storeDomain: 'cards.example.test', fetchFn, rateLimiter: testLimiter() });
  const [listing, unwanted] = await connector.fetchListings([sku]);
  assert.equal(unwanted, undefined);
  assert.equal(listing.title, 'Pokémon Surging Sparks - Booster Box');
  assert.equal(listing.url, 'https://cards.example.test/products/surging-sparks?variant=1');
  assert.equal(listing.priceCents, 12099);
  assert.equal(listing.upc, sku.upc);
  assert.equal(listing.supportsAutoCheckout, false);
});

test('TCGplayer joins the authorized catalog with market lows as manual leads', async t => {
  const { sku } = fixture(t);
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.tcgplayer.com');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer tcg-token');
    if (url.pathname.endsWith('/catalog/categories/3/search')) {
      assert.equal(init?.method, 'POST');
      return Response.json({ success: true, results: [123] });
    }
    if (url.pathname.endsWith('/catalog/products/123')) {
      return Response.json({ success: true, results: [{ productId: 123, name: sku.name, url: 'https://www.tcgplayer.com/product/123' }] });
    }
    assert.ok(url.pathname.endsWith('/pricing/product/123'));
    return Response.json({ success: true, results: [
      { productId: 123, lowPrice: 120.01, marketPrice: 166.42, subTypeName: 'Normal' },
      { productId: 123, lowPrice: null, marketPrice: 166.42, subTypeName: 'Foil' },
    ] });
  };
  const connector = new TcgplayerFeedConnector({ accessToken: 'tcg-token', fetchFn, rateLimiter: testLimiter() });
  const [listing, marketOnly] = await connector.fetchListings([sku]);
  assert.equal(marketOnly, undefined);
  assert.equal(listing.priceCents, 12001);
  assert.equal(listing.supportsAutoCheckout, false);
  assert.equal(listing.metadata?.priceType, 'catalogLow');
});

test('unconfigured connectors return an empty feed without network access', async t => {
  const { sku } = fixture(t);
  const fetchFn: FetchLike = async () => assert.fail('Unexpected network request');
  const connectors = [
    new EbayBrowseConnector({ accessToken: '', fetchFn }),
    new BestBuyApiConnector({ apiKey: '', fetchFn }),
    new CostcoConnector({ feedUrl: '', fetchFn }),
    new PokemonCenterConnector({ feedUrl: '', fetchFn }),
    new ShopifyStorefrontConnector({ storeDomain: '', fetchFn }),
    new TcgplayerFeedConnector({ accessToken: '', fetchFn }),
  ];
  for (const connector of connectors) {
    assert.equal(connector.isEnabled(), false);
    assert.deepEqual(await connector.fetchListings([sku]), []);
  }
});

test('mock feed returns 17 distinct and repeatable listings with the shared certs and scenario hints', async () => {
  const connector = new MockScenarioConnector();
  const listings = await connector.fetchListings([]);
  assert.equal(connector.isEnabled(), true);
  assert.equal(connector.supportsAutoCheckout, true);
  assert.deepEqual(listings, await connector.fetchListings([]));
  const byId = new Map(listings.map(listing => [listing.listingId, listing]));
  assert.equal(listings.length, 17);
  assert.equal(byId.size, 17);
  assert.ok(listings.every(listing => Number.isSafeInteger(listing.priceCents)));
  assert.equal(listings.filter(listing => listing.source === 'mock_feed').length, 15);
  assert.equal(byId.get('mock-costco-151-tins')?.source, 'costco');
  assert.equal(byId.get('mock-pc-pre-etb')?.source, 'pokemon_center');
  assert.deepEqual(listings.map(listing => [listing.listingId, listing.priceCents]), [
    ['mock-ssp-bb-clean', 9500], ['mock-lugia-cgc10-clean', 28500], ['mock-pre-etb-retailer', 5499],
    ['mock-moonbreon-psa10-highcap', 82000], ['mock-zard-raw-nm', 13000], ['mock-evs-bb-anomaly', 21000],
    ['mock-zard-cert-mismatch', 42000], ['mock-zard-proxy-trap', 4500], ['mock-evs-empty-box', 3000],
    ['mock-zard-jp-sv2a', 11500], ['mock-zard-006-holo', 2500], ['mock-crz-sketchy-seller', 3500],
    ['mock-snap-illiquid', 35000], ['mock-151-thin-margin', 4200], ['mock-digital-code-trap', 1000],
    ['mock-costco-151-tins', 3799], ['mock-pc-pre-etb', 5999],
  ]);
  assert.deepEqual(listings.flatMap(listing => listing.certNumber
    ? [[listing.listingId, listing.certNumber, listing.graderHint, listing.gradeHint]] : []), [
    ['mock-lugia-cgc10-clean', '4318920001', 'CGC', '10'],
    ['mock-moonbreon-psa10-highcap', '90123456', 'PSA', '10'],
    ['mock-zard-cert-mismatch', '90999888', 'PSA', '10'],
  ]);
  assert.equal(byId.get('mock-ssp-bb-clean')?.upc, '820650859120');
  assert.equal(byId.get('mock-lugia-cgc10-clean')?.shippingCents, 500);
  assert.equal(byId.get('mock-pre-etb-retailer')?.supportsAutoCheckout, false);
  assert.equal(byId.get('mock-zard-raw-nm')?.imageUrls.length, 2);
  assert.equal(byId.get('mock-zard-jp-sv2a')?.languageHint, 'JP');
  assert.equal(byId.get('mock-crz-sketchy-seller')?.seller.feedbackScore, 4);
  assert.match(byId.get('mock-digital-code-trap')?.title ?? '', /Digital Code/);
});

function saveDecision(db: ArbitrageDatabase, sku: CanonicalSku, listing: RawListing, config: ArbitrageConfig,
  action: ArbitrageDecision['action'] = 'auto_buy'): ArbitrageDecision {
  const tax = percentOfCents(listing.priceCents, config.salesTaxRate);
  const landed = listing.priceCents + listing.shippingCents + tax;
  const reserve = percentOfCents(landed, config.riskReserveRates[sku.assetClass]);
  const netProceeds = 14000;
  const profit = netProceeds - landed - reserve;
  const decision: ArbitrageDecision = {
    id: randomUUID(), listingId: listing.listingId, source: listing.source, listingUrl: listing.url,
    listingTitle: listing.title, skuId: sku.id, skuName: sku.name, assetClass: sku.assetClass,
    action, intendedAction: action, operatingMode: config.operatingMode, matchConfidence: 1,
    fmvCents: 16500, warnings: [], reasons: [], anomalyFlagged: false, decidedAt: new Date().toISOString(),
    bestExit: {
      exitChannel: 'ebay', askPriceCents: listing.priceCents, inboundShippingCents: listing.shippingCents,
      estimatedTaxCents: tax, landedCostCents: landed, expectedExitPriceCents: 16500, exitFeeCents: 1450,
      outboundShippingCents: 850, packagingCents: 200, netProceedsCents: netProceeds, riskReserveCents: reserve,
      netProfitCents: profit, netRoi: profit / landed, discountToFmv: (16500 - listing.priceCents) / 16500,
    },
  };
  db.saveDecision(decision);
  return decision;
}

async function executionFixture(t: TestContext, overrides: Partial<ArbitrageConfig> = {},
  action: ArbitrageDecision['action'] = 'auto_buy') {
  const { db, sku } = fixture(t);
  const [listing] = await new MockScenarioConnector().fetchListings([]);
  const config = createConfig({
    operatingMode: 'live', salesTaxRate: 0.08, autoBuyMaxOrderCents: 50000, dailySpendCapCents: 100000,
    minCashReserveCents: 50000, cashBalanceCents: 500000, maxPositionPerSku: 5, ...overrides,
  });
  const decision = saveDecision(db, sku, listing, config, action);
  return { db, sku, listing, config, decision };
}

test('listing lock blocks competing checkout and releases after an adapter throws', async t => {
  const { db, listing, config, decision } = await executionFixture(t);
  const started = Promise.withResolvers<void>();
  const failCheckout = Promise.withResolvers<void>();
  const adapter: ExecutionAdapter = {
    verifyLiveListing: listing => new SimulatedApiExecutor().verifyLiveListing(listing),
    async executePurchase() {
      started.resolve();
      await failCheckout.promise;
      throw new Error('Sandbox checkout failed');
    },
  };
  const coordinator = new ExecutionCoordinator({ db, config, adapter });
  const first = coordinator.executeDecision(decision, listing);
  await started.promise;
  assert.equal((await coordinator.executeDecision(decision, listing)).status, 'locked');
  failCheckout.resolve();
  const failed = await first;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.order?.failureReason, 'Sandbox checkout failed');
  assert.equal(db.listInventory().length, 0);
  assert.equal(db.listAuditEvents()[0].eventType, 'order.failed');
  const key = `${listing.source}:${listing.listingId}`;
  assert.equal(db.acquirePurchaseLock(key, 'next-worker', 1000), true);
  assert.equal(db.releasePurchaseLock(key, 'next-worker'), true);
});

test('idempotency prevents a second buy and preserves the filled inventory and audit', async t => {
  const { db, listing, config, decision } = await executionFixture(t);
  const sim = new SimulatedApiExecutor();
  const place = t.mock.method(sim, 'executePurchase');
  const coordinator = new ExecutionCoordinator({ db, config, adapter: sim });
  const first = await coordinator.executeDecision(decision, listing);
  const second = await coordinator.executeDecision(decision, listing);
  assert.equal(first.status, 'filled');
  assert.equal(second.status, 'duplicate');
  assert.equal(second.order?.id, first.order?.id);
  assert.equal(first.order?.idempotencyKey,
    createHash('sha256').update(`${listing.source}:${listing.listingId}:${listing.priceCents}:${listing.shippingCents}`).digest('hex'));
  assert.match(first.order?.externalOrderId ?? '', /^sim-/);
  assert.equal(place.mock.callCount(), 1);
  assert.equal(db.listOrders().length, 1);
  assert.equal(db.listInventory().length, 1);
  assert.equal(db.listAuditEvents()[0].eventType, 'order.filled');
});

test('live price drift aborts before an order or checkout is created', async t => {
  const { db, listing, config, decision } = await executionFixture(t);
  const sim = new SimulatedApiExecutor({ [listing.listingId]: { currentPriceCents: listing.priceCents + 1 } });
  const place = t.mock.method(sim, 'executePurchase');
  const coordinator = new ExecutionCoordinator({ db, config, adapter: sim });
  assert.deepEqual(await coordinator.executeDecision(decision, listing), {
    status: 'aborted', reason: 'Live price drifted higher before checkout',
  });
  assert.equal(place.mock.callCount(), 0);
  assert.equal(db.listOrders().length, 0);
});

test('unavailable listings abort and lower live quotes set the new cost basis', async t => {
  const { db, listing, config, decision } = await executionFixture(t);
  const unavailable = new ExecutionCoordinator({
    db, config, adapter: new SimulatedApiExecutor({ [listing.listingId]: { available: false, reason: 'Sold' } }),
  });
  assert.deepEqual(await unavailable.executeDecision(decision, listing), { status: 'aborted', reason: 'Sold' });
  const lower = new ExecutionCoordinator({
    db, config, adapter: new SimulatedApiExecutor({ [listing.listingId]: { currentPriceCents: 9000 } }),
  });
  const outcome = await lower.executeDecision(decision, listing);
  assert.equal(outcome.status, 'filled');
  assert.equal(outcome.order?.askPriceCents, 9000);
  assert.equal(outcome.inventoryItem?.costBasisCents, 9720);
});

test('kill switch blocks automatic and approved execution, including changes during live verification', async t => {
  const { db, listing, config, decision, sku } = await executionFixture(t);
  const sim = new SimulatedApiExecutor();
  const verify = t.mock.method(sim, 'verifyLiveListing');
  const place = t.mock.method(sim, 'executePurchase');
  const coordinator = new ExecutionCoordinator({ db, config, adapter: sim });
  db.setKillSwitch(true, 'Manual stop');
  assert.deepEqual(await coordinator.executeDecision(decision, listing), { status: 'aborted', reason: 'Kill switch engaged' });
  assert.equal(verify.mock.callCount(), 0);
  const queuedDecision = saveDecision(db, sku, listing, config, 'hitl_review');
  const queued = await coordinator.executeDecision(queuedDecision, listing);
  assert.ok(queued.order);
  assert.equal((await coordinator.executeApprovedOrder(queued.order.id, listing)).status, 'aborted');
  assert.equal(db.getOrder(queued.order.id)?.status, 'pending_hitl');

  db.setKillSwitch(false);
  verify.mock.mockImplementation(async () => {
    db.setKillSwitch(true, 'Changed during availability check');
    return { available: true, currentPriceCents: listing.priceCents, currentShippingCents: listing.shippingCents };
  });
  assert.equal((await coordinator.executeApprovedOrder(queued.order.id, listing)).reason, 'Kill switch engaged');
  assert.equal(place.mock.callCount(), 0);
});

test('portfolio is checked before checkout and again after verifying other listings concurrently', async t => {
  const { db, listing, config, decision, sku } = await executionFixture(t, { dailySpendCapCents: 11000 });
  const second = { ...listing, listingId: 'another-listing' };
  const secondDecision = saveDecision(db, sku, second, config);
  const sim = new SimulatedApiExecutor();
  const verify = t.mock.method(sim, 'verifyLiveListing');
  const place = t.mock.method(sim, 'executePurchase');
  const coordinator = new ExecutionCoordinator({ db, config, adapter: sim });
  const outcomes = await Promise.all([coordinator.executeDecision(decision, listing), coordinator.executeDecision(secondDecision, second)]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['aborted', 'filled']);
  assert.equal(outcomes.find(outcome => outcome.status === 'aborted')?.reason, 'Daily spend cap exceeded');
  assert.equal(verify.mock.callCount(), 2);
  assert.equal(place.mock.callCount(), 1);
  const third = { ...listing, listingId: 'third-listing' };
  const thirdDecision = saveDecision(db, sku, third, config);
  assert.equal((await coordinator.executeDecision(thirdDecision, third)).status, 'aborted');
  assert.equal(verify.mock.callCount(), 2);
});

test('shadow orders record an external ID while daily spend stays zero', async t => {
  const { db, listing, config, decision } = await executionFixture(t, { operatingMode: 'shadow' });
  const sim = new SimulatedApiExecutor();
  const place = t.mock.method(sim, 'executePurchase');
  const coordinator = new ExecutionCoordinator({ db, config, adapter: sim });
  const outcome = await coordinator.executeDecision(decision, listing);
  assert.equal(outcome.status, 'shadow_recorded');
  assert.ok(outcome.order);
  const shadow = new ShadowExecutor();
  assert.equal((await shadow.executePurchase(outcome.order, listing)).externalOrderId, outcome.order.externalOrderId);
  assert.equal(place.mock.callCount(), 0);
  assert.equal(db.getDailySpendCents('2020-01-01T00:00:00.000Z'), 0);
  assert.equal(db.listAuditEvents()[0].eventType, 'order.shadow_recorded');
});

test('HITL queues and approves through verification, placement, and inventory creation', async t => {
  const { db, listing, config, decision } = await executionFixture(t, { operatingMode: 'hitl' }, 'hitl_review');
  const sim = new SimulatedApiExecutor();
  const place = t.mock.method(sim, 'executePurchase');
  const coordinator = new ExecutionCoordinator({ db, config, adapter: sim });
  const queued = await coordinator.executeDecision(decision, listing);
  assert.equal(queued.status, 'pending_hitl');
  assert.ok(queued.order);
  assert.equal(db.getDailySpendCents('2020-01-01T00:00:00.000Z'), 0);
  assert.equal(place.mock.callCount(), 0);
  const filled = await coordinator.executeApprovedOrder(queued.order.id, listing);
  assert.equal(filled.status, 'filled');
  assert.equal(place.mock.callCount(), 1);
  assert.equal(place.mock.calls[0].arguments[0].status, 'executing');
  assert.equal(filled.order?.id, queued.order.id);
  assert.equal(filled.inventoryItem?.orderId, queued.order.id);
  assert.equal(filled.inventoryItem?.expectedCondition, 'SEALED');
  assert.equal(filled.inventoryItem?.expectedFmvCents, decision.fmvCents);
  assert.equal(filled.inventoryItem?.status, 'in_transit');
  assert.equal((await coordinator.executeApprovedOrder(queued.order.id, listing)).status, 'aborted');
  assert.deepEqual(db.listAuditEvents().map(event => event.eventType), ['order.filled', 'order.pending_hitl']);
});

test('eBay checks the current listing and uses the sanctioned member checkout routes', async t => {
  const { db, sku, listing, config } = await executionFixture(t);
  const ebayListing: RawListing = { ...listing, source: 'ebay', listingId: 'v1|123|0' };
  const decision = saveDecision(db, sku, ebayListing, config);
  const calls: string[] = [];
  const executor = new EbayOrderApiExecutor({
    accessToken: 'order-token', browseAccessToken: 'browse-token', sandbox: true,
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      calls.push(`${init?.method} ${path}`);
      const token = new Headers(init?.headers).get('Authorization');
      const amount = (value: string) => ({ value, currency: 'USD' });
      if (path.includes('/browse/')) {
        assert.equal(token, 'Bearer browse-token');
        assert.equal(url.hostname, 'api.sandbox.ebay.com');
        return Response.json({
          price: amount('95.00'), shippingOptions: [{ shippingCost: amount('0.00') }],
          buyingOptions: ['FIXED_PRICE'], estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }],
        });
      }
      assert.equal(token, 'Bearer order-token');
      if (path.endsWith('/initiate')) {
        assert.equal(url.hostname, 'apix.sandbox.ebay.com');
        assert.deepEqual(JSON.parse(String(init?.body)), { lineItemInputs: [{ itemId: ebayListing.listingId, quantity: 1 }] });
        return Response.json({ checkoutSessionId: 'session', pricingSummary: { total: amount('102.60') } });
      }
      if (path.endsWith('/place_order')) {
        assert.equal(url.hostname, 'apix.sandbox.ebay.com');
        assert.equal(init?.body, '{}');
        return Response.json({ purchaseOrderId: 'remote-id', purchaseOrderPaymentStatus: 'PENDING' });
      }
      assert.equal(url.hostname, 'api.sandbox.ebay.com');
      return Response.json({ purchaseOrderId: 'remote-id', purchaseOrderPaymentStatus: 'PAID' });
    },
  });
  const coordinator = new ExecutionCoordinator({ db, config, adapter: executor });
  const filled = await coordinator.executeDecision(decision, ebayListing);
  assert.equal(filled.status, 'filled');
  assert.equal(filled.order?.externalOrderId, 'remote-id');
  assert.deepEqual(calls, [
    'GET /buy/browse/v1/item/v1%7C123%7C0',
    'POST /buy/order/v1/checkout_session/initiate',
    'POST /buy/order/v1/checkout_session/session/place_order',
    'GET /buy/order/v1/purchase_order/remote-id',
  ]);
});

test('eBay guest checkout uses the widget security signature and verifies the resulting purchase order', async t => {
  const { db, sku, listing, config } = await executionFixture(t);
  const ebayListing: RawListing = { ...listing, source: 'ebay', listingId: 'v1|321|0' };
  const decision = saveDecision(db, sku, ebayListing, config, 'hitl_review');
  const pricingSummary = { total: { currency: 'USD', value: '102.60' } };
  const calls: string[] = [];
  const executor = new EbayOrderApiExecutor({
    accessToken: 'guest-token',
    guestCheckout: {
      contactEmail: 'buyer@example.test',
      shippingAddress: {
        recipient: 'Test Buyer', addressLine1: '100 Test Street', city: 'State College',
        stateOrProvince: 'PA', postalCode: '16801', country: 'US',
      },
      async completeWithWidget(session) {
        calls.push('widget');
        assert.deepEqual(session, { checkoutSessionId: 'guest-session', securityToken: 'widget-signature' });
        return 'guest-order';
      },
    },
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${url.hostname}${url.pathname}`);
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer guest-token');
      if (url.pathname.endsWith('/initiate')) {
        assert.equal(init?.method, 'POST');
        assert.equal(JSON.parse(String(init?.body)).contactEmail, 'buyer@example.test');
        return Response.json({ checkoutSessionId: 'guest-session', pricingSummary }, {
          headers: { 'X-EBAY-SECURITY-SIGNATURE': 'widget-signature' },
        });
      }
      assert.equal(init?.method, 'GET');
      return Response.json({
        purchaseOrderId: 'guest-order', purchaseOrderPaymentStatus: 'PAID', pricingSummary,
        lineItems: [{ itemId: ebayListing.listingId, quantity: 1 }],
      });
    },
  });
  const coordinator = new ExecutionCoordinator({ db, config, adapter: executor });
  const queued = await coordinator.executeDecision(decision, ebayListing);
  assert.ok(queued.order);
  const filled = await coordinator.executeApprovedOrder(queued.order.id);
  assert.equal(filled.order?.externalOrderId, 'guest-order');
  assert.equal(filled.status, 'filled');
  assert.deepEqual(calls, [
    'apix.ebay.com/buy/order/v2/guest_checkout_session/initiate',
    'widget', 'api.ebay.com/buy/order/v2/guest_purchase_order/guest-order',
  ]);
});

test('eBay missing credentials fail cleanly and excess checkout totals block placement', async t => {
  const { db, sku, listing, config } = await executionFixture(t);
  const ebayListing: RawListing = { ...listing, source: 'ebay', listingId: 'v1|456|0' };
  const decision = saveDecision(db, sku, ebayListing, config, 'hitl_review');
  const executor = new EbayOrderApiExecutor({
    accessToken: '', fetchFn: async () => assert.fail('Unexpected network request'),
  });
  const approval = new ExecutionCoordinator({ db, config, adapter: executor });
  const queued = await approval.executeDecision(decision, ebayListing);
  assert.ok(queued.order);
  assert.equal((await approval.executeApprovedOrder(queued.order.id, ebayListing)).reason, 'eBay Order API token is missing');
  assert.equal(db.getOrder(queued.order.id)?.status, 'pending_hitl');

  const calls: string[] = [];
  const expensive = new EbayOrderApiExecutor({
    accessToken: 'order-token',
    fetchFn: async input => {
      calls.push(new URL(String(input)).pathname);
      return Response.json({
        checkoutSessionId: 'expensive', pricingSummary: { total: { currency: 'USD', value: '103.00' } },
      });
    },
  });
  const coordinator = new ExecutionCoordinator({ db, config, adapter: expensive });
  const failed = await coordinator.executeApprovedOrder(queued.order.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason ?? '', /exceeds the approved cost/);
  assert.deepEqual(calls, ['/buy/order/v1/checkout_session/initiate']);
  assert.equal(db.listInventory().length, 0);
});

test('webhook sends Slack and Discord payloads and absorbs delivery errors', async () => {
  const bodies: unknown[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    assert.equal(init?.method, 'POST');
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 500 });
  };
  await new WebhookNotifier({ webhookUrl: 'https://hooks.slack.com/services/test', fetchFn }).notifyCircuitBreaker('A < B');
  await new WebhookNotifier({ webhookUrl: 'https://discord.com/api/webhooks/test', fetchFn }).notifyCircuitBreaker('Review');
  assert.deepEqual(bodies, [
    { text: 'Circuit breaker engaged\nA &lt; B', unfurl_links: false, unfurl_media: false },
    { content: 'Circuit breaker engaged\nReview', allowed_mentions: { parse: [] } },
  ]);
  await assert.doesNotReject(new WebhookNotifier({
    webhookUrl: 'https://alerts.example.test/webhook',
    fetchFn: async () => { throw new Error('Network down'); },
  }).notifyCircuitBreaker('Review'));
});
