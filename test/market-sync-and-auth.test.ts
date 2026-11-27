import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createSystemRuntime } from '../src/cli.ts';
import { createConfig } from '../src/config.ts';
import { TokenBucketRateLimiter } from '../src/connectors/base.ts';
import type { FetchLike } from '../src/connectors/base.ts';
import { EbayOAuthTokenManager } from '../src/connectors/ebayAuth.ts';
import { EbayBrowseConnector } from '../src/connectors/ebayConnector.ts';
import { ArbitrageDatabase } from '../src/db/database.ts';
import type { CanonicalSku, PurchaseOrder } from '../src/domain/types.ts';
import { AutopilotEngine } from '../src/engine/autopilot.ts';
import { BuyBook } from '../src/engine/buyBook.ts';
import { EbayOrderApiExecutor } from '../src/execution/executor.ts';
import { parseWebhookListing } from '../src/mcp/mcpServer.ts';
import { CompositeNotifier, NullNotifier } from '../src/notifications/notifier.ts';
import { createArbitrageServer } from '../src/server/httpServer.ts';
import { EbaySoldCompsSyncer, MarketSyncCoordinator, PokemonTcgApiCatalogSyncer, PriceChartingSyncer } from '../src/sync/marketSync.ts';
import type { MarketSyncProvider, MarketSyncSummary } from '../src/sync/marketSync.ts';
import { FmvEngine } from '../src/valuation/fmvEngine.ts';

const nowIso = '2026-11-26T12:00:00.000Z';
const card = {
  id: 'tst-123', name: 'Pikachu ex', number: '123', rarity: 'Special Illustration Rare',
  set: { id: 'tst', name: 'Test Set', printedTotal: 100 },
  images: { large: 'https://images.example.test/pikachu.jpg' },
  tcgplayer: { prices: { holofoil: { market: 25.31 }, normal: { market: 5 } } },
};
const raw: CanonicalSku = {
  id: 'raw', name: card.name, assetClass: 'raw', setCode: card.set.id, setName: card.set.name,
  cardNumber: '123/100', language: 'EN', variant: 'sir', aliases: [], createdAt: nowIso, updatedAt: nowIso,
};
const graded: CanonicalSku = { ...raw, id: 'graded', assetClass: 'graded', grader: 'PSA', grade: '9' };
const sealed: CanonicalSku = {
  ...raw, id: 'sealed', name: 'Test Set Booster Box', assetClass: 'sealed', variant: 'standard', cardNumber: undefined,
};
const listing = parseWebhookListing({ title: 'Pikachu ex 123/100', priceCents: 1900, source: 'ebay', listingId: 'item' });
const offline: FetchLike = async () => assert.fail('Unexpected network request');

function dbFor(t: TestContext) {
  const db = new ArbitrageDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function env(t: TestContext, values: Record<string, string | undefined>): void {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  t.after(() => apply(old));
  apply(values);
}

function rateLimiter() {
  return new TokenBucketRateLimiter({ capacity: 100, refillPerSecond: 100 });
}

function auth(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('Authorization');
}

test('eBay OAuth client credentials cache, refresh at the buffer, and deduplicate parallel requests', async () => {
  let now = 1000;
  let requests = 0;
  const manager = new EbayOAuthTokenManager({
    clientId: 'client', clientSecret: 'secret', refreshToken: '', sandbox: true, nowFn: () => now,
    fetchFn: async (url, init) => {
      assert.equal(url, 'https://api.sandbox.ebay.com/identity/v1/oauth2/token');
      assert.equal(auth(init), 'Basic ' + Buffer.from('client:secret').toString('base64'));
      assert.equal(String(init?.body), 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope');
      return Response.json({ access_token: 'token-' + ++requests, expires_in: 300 });
    },
  });
  assert.equal(manager.isConfigured(), true);
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => manager.getAccessToken())), Array(6).fill('token-1'));
  now += 179_999;
  assert.equal(await manager.getAccessToken(), 'token-1');
  now++;
  assert.equal(await manager.getAccessToken(), 'token-2');
  manager.invalidate();
  assert.equal(await manager.getAccessToken(), 'token-3');
  assert.equal(requests, 3);
});

test('eBay refresh token grant takes precedence and a failed refresh releases the single flight', async () => {
  let count = 0;
  const manager = new EbayOAuthTokenManager({
    staticToken: 'unused', clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh+token',
    scopes: ['scope-one', 'scope-two'], tokenUrl: 'https://mock.example.test/oauth',
    fetchFn: async (url, init) => {
      assert.equal(url, 'https://mock.example.test/oauth');
      const body = new URLSearchParams(String(init?.body));
      assert.deepEqual(Object.fromEntries(body), {
        grant_type: 'refresh_token', refresh_token: 'refresh+token', scope: 'scope-one scope-two',
      });
      if (++count === 1) return new Response(null, { status: 400 });
      return Response.json({ access_token: 'user-token', expires_in: 3600 });
    },
  });
  await assert.rejects(manager.getAccessToken(), /HTTP 400/);
  assert.equal(await manager.getAccessToken(), 'user-token');
});

test('explicit empty tokens suppress OAuth and a Browse token cannot become an Order token', async t => {
  env(t, { EBAY_ACCESS_TOKEN: 'browse-only', EBAY_ORDER_API_TOKEN: undefined, EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 'secret' });
  const disabled = new EbayOAuthTokenManager({ staticToken: '', fetchFn: offline });
  assert.equal(disabled.isConfigured(), false);
  await assert.rejects(disabled.getAccessToken(), /credentials are missing/);
  const connector = new EbayBrowseConnector({ accessToken: '', fetchFn: offline });
  assert.equal(connector.isEnabled(), false);
  assert.deepEqual(await connector.fetchListings([raw]), []);
  const explicitlyDisabled = new EbayOrderApiExecutor({ accessToken: '', fetchFn: offline });
  assert.equal((await explicitlyDisabled.verifyLiveListing(listing)).available, false);
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.EBAY_CLIENT_SECRET;
  const noOrderToken = new EbayOrderApiExecutor({ fetchFn: offline });
  assert.equal((await noOrderToken.verifyLiveListing(listing)).available, false);
});

function rotatingProvider() {
  let generation = 0;
  return {
    isConfigured: () => true,
    getAccessToken: async () => 'token-' + generation,
    invalidate: () => { generation++; },
  };
}

test('eBay Browse invalidates on 401 and retries exactly once', async () => {
  const tokens: (string | null)[] = [];
  const connector = new EbayBrowseConnector({
    tokenProvider: rotatingProvider(), rateLimiter: rateLimiter(),
    fetchFn: async (_url, init) => {
      tokens.push(auth(init));
      return new Response(null, { status: 401 });
    },
  });
  await assert.rejects(connector.fetchListings([raw]), /HTTP 401/);
  assert.deepEqual(tokens, ['Bearer token-0', 'Bearer token-1']);
});

test('eBay Order retries Browse verification and order placement with refreshed tokens', async () => {
  const calls: (string | null)[] = [];
  const executor = new EbayOrderApiExecutor({
    tokenProvider: rotatingProvider(), browseTokenProvider: rotatingProvider(),
    fetchFn: async (url, init) => {
      calls.push(auth(init));
      if (String(url).includes('/browse/')) {
        if (calls.at(-1) === 'Bearer token-0') return new Response(null, { status: 401 });
        return Response.json({
          price: { value: '19.00', currency: 'USD' }, buyingOptions: ['FIXED_PRICE'],
          shippingOptions: [{ shippingCost: { value: '0', currency: 'USD' } }],
          estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }],
        });
      }
      if (String(url).endsWith('/initiate')) return Response.json({
        checkoutSessionId: 'session', pricingSummary: { total: { value: '19.00', currency: 'USD' } },
      });
      assert.match(String(url), /\/place_order$/);
      if (calls.at(-1) === 'Bearer token-0') return new Response(null, { status: 401 });
      return Response.json({ purchaseOrderId: 'receipt', purchaseOrderPaymentStatus: 'PAID' });
    },
  });
  const order: PurchaseOrder = {
    id: 'order', idempotencyKey: 'key', decisionId: 'decision', status: 'executing',
    listingId: listing.listingId, source: 'ebay', listingUrl: '', listingTitle: listing.title,
    skuId: raw.id, skuName: raw.name, assetClass: 'raw', quantity: 1,
    askPriceCents: 1900, shippingCents: 0, taxCents: 0, landedCostCents: 1900,
    expectedNetProfitCents: 500, expectedNetRoi: 0.26, recommendedExitChannel: 'ebay', decisionWarnings: [],
    createdAt: nowIso, updatedAt: nowIso,
  };
  assert.equal((await executor.verifyLiveListing(listing)).available, true);
  assert.deepEqual(await executor.executePurchase(order, listing), { success: true, externalOrderId: 'receipt' });
  assert.deepEqual(calls, ['Bearer token-0', 'Bearer token-1', 'Bearer token-0', 'Bearer token-0', 'Bearer token-1']);
});

test('Pokémon TCG catalog maps cards, reuses known SKUs, and deduplicates daily prices', async t => {
  const db = dbFor(t);
  const existing = { ...raw, createdAt: '2026-01-01T00:00:00.000Z' };
  db.upsertSku(existing);
  const syncer = new PokemonTcgApiCatalogSyncer({
    apiKey: 'catalog', rateLimiter: rateLimiter(),
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/v2/cards');
      assert.equal(url.searchParams.get('q'), 'rarity:"Special Illustration Rare" OR rarity:"Hyper Rare"');
      assert.equal(url.searchParams.get('orderBy'), '-set.releaseDate');
      assert.equal(url.searchParams.get('pageSize'), '2');
      assert.equal(new Headers(init?.headers).get('X-Api-Key'), 'catalog');
      return Response.json({ data: [card, { ...card, id: 'promo-4', number: '4', rarity: 'Promo', tcgplayer: undefined }] });
    },
  });
  const result = await syncer.sync(db, { nowIso, limit: 2 });
  assert.deepEqual([result.skusUpserted, result.compsInserted, result.errors], [2, 1, []]);
  const updated = db.getSku(raw.id);
  assert.equal(updated?.createdAt, existing.createdAt);
  assert.deepEqual(updated?.aliases, ['Pikachu ex 123/100', 'Test Set Pikachu ex']);
  assert.equal(updated?.referenceImageUrl, card.images.large);
  assert.equal(db.getSku('ptcg-api-promo-4')?.variant, 'promo');
  assert.equal(db.getSoldComps(raw.id)[0].id, 'ptcg-api-tst-123-2026-11-26');
  assert.equal(db.getSoldComps(raw.id)[0].soldPriceCents, 2531);
  assert.equal((await syncer.sync(db, { nowIso, limit: 2 })).compsInserted, 0);
});

test('PriceCharting selects Pokémon products and consumes integer cents from search or detail', async t => {
  const db = dbFor(t);
  const psa10 = { ...graded, id: 'graded-psa10', grade: '10' };
  const sgc10 = { ...psa10, id: 'sgc10', grader: 'SGC' } as const;
  [graded, raw, sealed, psa10, sgc10].forEach(sku => db.upsertSku(sku));
  const syncer = new PriceChartingSyncer({
    apiToken: 'prices', rateLimiter: rateLimiter(),
    fetchFn: async input => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('t'), 'prices');
      if (url.pathname === '/api/product') {
        assert.equal(url.searchParams.get('id'), 'sealed');
        return Response.json({ status: 'success', 'new-price': 12_345 });
      }
      assert.equal(url.pathname, '/api/products');
      const isSealed = url.searchParams.get('q') === sealed.name;
      return Response.json({ status: 'success', products: [
        { 'product-name': 'Other game', 'console-name': 'Pokemon', 'loose-price': 9 },
        isSealed ? { id: 'sealed', 'product-name': sealed.name, 'console-name': 'Pokémon Test Set' } : {
          'product-name': 'Pikachu ex #123', 'console-name': 'Pokémon Test Set', 'loose-price': 2531, 'graded-price': 6935,
          'manual-only-price': 9050, 'condition-18-price': 7950,
        },
      ] });
    },
  });
  const result = await syncer.sync(db, { nowIso, limit: 5 });
  assert.deepEqual([result.compsInserted, result.errors], [4, []]);
  assert.deepEqual([graded, psa10, raw, sealed].map(sku => db.getSoldComps(sku.id)[0].soldPriceCents), [6935, 9050, 2531, 12_345]);
  assert.deepEqual(db.getSoldComps(sgc10.id), []);
  assert.equal(db.getSoldComps(sealed.id)[0].condition, 'SEALED');
  assert.equal(db.getSoldComps(raw.id)[0].source, 'pricecharting');
  assert.equal((await syncer.sync(db, { nowIso, limit: 5 })).compsInserted, 0);
});

test('Insights parses USD sales, requires a matching SKU, and deduplicates by item ID', async t => {
  const db = dbFor(t);
  db.upsertSku(graded);
  const sale = {
    itemId: 'item', title: 'Pikachu ex 123/100 PSA 9', lastSoldDate: nowIso,
    lastSoldPrice: { value: '91.25', currency: 'USD' }, condition: 'Near Mint',
  };
  const syncer = new EbaySoldCompsSyncer({
    enabled: true, tokenProvider: rotatingProvider(), rateLimiter: rateLimiter(),
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/buy/marketplace_insights/v1_beta/item_sales/search');
      assert.equal(url.searchParams.get('q'), 'Pikachu ex 123/100');
      assert.equal(auth(init), 'Bearer token-0');
      return Response.json({ itemSales: [sale, sale,
        { ...sale, itemId: 'cad', lastSoldPrice: { value: '102', currency: 'CAD' } },
        { ...sale, itemId: 'different-grade', title: 'Pikachu ex 123/100 PSA 10' },
        { ...sale, itemId: 'no-date', lastSoldDate: 'unknown' },
      ] });
    },
  });
  assert.equal((await syncer.sync(db, { limit: 1 })).compsInserted, 1);
  assert.equal((await syncer.sync(db, { limit: 1 })).compsInserted, 0);
  assert.deepEqual(db.getSoldComps(graded.id), [{
    id: 'ebay-sale-item', skuId: graded.id, source: 'ebay', soldPriceCents: 9125, totalPriceCents: 9125,
    shippingCents: 0, condition: 'NM', grader: 'PSA', grade: '9', soldAt: nowIso,
  }]);
});

test('unconfigured market providers make zero network calls', async t => {
  const db = dbFor(t);
  db.upsertSku(raw);
  for (const syncer of [
    new PokemonTcgApiCatalogSyncer({ apiKey: '', fetchFn: offline }),
    new PriceChartingSyncer({ apiToken: '', fetchFn: offline }),
    new EbaySoldCompsSyncer({ enabled: false, tokenProvider: rotatingProvider(), fetchFn: offline }),
    new EbaySoldCompsSyncer({ enabled: true, accessToken: '', fetchFn: offline }),
  ]) {
    assert.equal(syncer.isEnabled(), false);
    assert.deepEqual(await syncer.sync(db),
      { provider: syncer.name, enabled: false, skusUpserted: 0, compsInserted: 0, errors: [] });
  }
});

function catalogFixture() {
  return new PokemonTcgApiCatalogSyncer({ enabled: true, fetchFn: async () => Response.json({ data: [card] }) });
}

test('market coordinator isolates provider failures and refreshes the Buy Book', async t => {
  const db = dbFor(t);
  const failing: MarketSyncProvider = {
    name: 'failing', isEnabled: () => true, async sync() { throw new Error('Provider unavailable'); },
  };
  const coordinator = new MarketSyncCoordinator(db, [failing, catalogFixture()], { nowFn: () => new Date(nowIso) });
  const buyBook = new BuyBook();
  const result = await coordinator.syncAll({ buyBook, fmvEngine: new FmvEngine(), config: createConfig(), limit: 1 });
  assert.deepEqual([result.startedAt, result.finishedAt], [nowIso, nowIso]);
  assert.deepEqual([result.totalSkusUpserted, result.totalCompsInserted, result.errorCount], [1, 1, 1]);
  assert.deepEqual(result.providers[0].errors, ['Provider unavailable']);
  assert.equal(buyBook.get('ptcg-api-tst-123')?.computedAt, nowIso);
  assert.equal(db.listAuditEvents(1)[0].eventType, 'market.sync_completed');
});

test('autopilot scheduled sync is tracked through shutdown and refreshes its Buy Book', { timeout: 3000 }, async t => {
  const runtime = createSystemRuntime({ dbPath: ':memory:', useMock: true, quiet: true });
  t.after(() => runtime.db.close());
  const fixture = catalogFixture();
  let syncRequested!: () => void;
  const requestingSync = new Promise<void>(resolve => { syncRequested = resolve; });
  runtime.marketSync = new MarketSyncCoordinator(runtime.db, [{
    name: fixture.name, isEnabled: () => true,
    async sync(db, options) {
      const result = await fixture.sync(db, options);
      syncRequested();
      return result;
    },
  }]);
  const autopilot = new AutopilotEngine(runtime);
  t.after(() => autopilot.stopDaemon());
  autopilot.startDaemon({ syncIntervalMs: 10 });
  await requestingSync;
  autopilot.stopDaemon();
  await autopilot.waitForIdle();
  assert.ok(autopilot.getBuyBook().get('ptcg-api-tst-123'));
});

test('CompositeNotifier isolates both thrown and rejected alerts', async () => {
  const good = new NullNotifier();
  const first = new NullNotifier();
  const second = new NullNotifier();
  first.notifyCircuitBreaker = () => { throw new Error('sync failure'); };
  second.notifyCircuitBreaker = async () => { throw new Error('async failure'); };
  const calls: string[] = [];
  good.notifyCircuitBreaker = reason => { calls.push(reason); };
  await new CompositeNotifier([first, second, good]).notifyCircuitBreaker('reason');
  assert.deepEqual(calls, ['reason']);
});

test('live runtime wires vision and webhook alerts while quiet keeps console stdout clear', async t => {
  env(t, {
    VISION_API_KEY: 'vision', VISION_API_URL: 'https://vision.example.test/v1', VISION_MODEL: 'vision-model',
    ARBITRAGE_WEBHOOK_URL: 'https://alerts.example.test/webhook',
  });
  const endpoints: string[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    endpoints.push(url.href);
    if (url.hostname === 'vision.example.test') {
      assert.equal(auth(init), 'Bearer vision');
      assert.equal(JSON.parse(String(init?.body)).model, 'vision-model');
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        verified: true, confidenceAdjustment: 0.01, notes: ['live assessment'],
      }) } }] });
    }
    assert.equal(url.hostname, 'alerts.example.test');
    assert.equal(init?.method, 'POST');
    return new Response(null, { status: 204 });
  };
  t.mock.method(globalThis, 'fetch', fetchFn);
  const info = t.mock.method(console, 'info', () => assert.fail('Quiet runtime wrote to stdout'));
  const runtime = createSystemRuntime({ dbPath: ':memory:', mode: 'shadow', quiet: true });
  t.after(() => runtime.db.close());
  runtime.db.upsertSku(raw);
  const photographed = { ...listing, priceCents: 12_300, imageUrls: ['https://image.example.test/card'] };
  const match = await runtime.resolver.resolve(photographed, [raw]);
  assert.deepEqual(match.visionVerification?.notes, ['live assessment']);
  const { MockScenarioConnector } = await import('../src/connectors/mockScenarioConnector.ts');
  const connector = new MockScenarioConnector();
  const mockRuntime = createSystemRuntime({ dbPath: ':memory:', useMock: true, quiet: true });
  t.after(() => mockRuntime.db.close());
  const fallback = await mockRuntime.resolver.resolve(photographed, [raw]);
  assert.notDeepEqual(fallback.visionVerification?.notes, ['live assessment']);
  // Use fixture listings and prices with the live runtime to exercise the alert path without contacting eBay.
  for (const sku of mockRuntime.db.listSkus()) {
    runtime.db.upsertSku(sku);
    runtime.db.insertSoldComps(mockRuntime.db.getSoldComps(sku.id));
  }
  await runtime.pipeline.runCycle({ connectors: [connector] });
  assert.ok(endpoints.includes('https://alerts.example.test/webhook'));
  assert.equal(info.mock.callCount(), 0);
});

test('HTTP POST /api/sync validates limit, imports data, refreshes Buy Book, and reports missing coordinator', async t => {
  const runtime = createSystemRuntime({ dbPath: ':memory:', useMock: true, quiet: true, seedCatalog: false });
  t.after(() => runtime.db.close());
  const autopilot = new AutopilotEngine(runtime);
  async function serve(marketSync?: MarketSyncCoordinator) {
    const server = createArbitrageServer({ ...runtime, autopilot, marketSync });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return 'http://127.0.0.1:' + address.port + '/api/sync';
  }
  const url = await serve(new MarketSyncCoordinator(runtime.db, [catalogFixture()]));
  const post = (target: string, input: unknown) =>
    fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal((await post(url, { limit: 1.5 })).status, 400);
  const response = await post(url, { limit: 1 });
  assert.equal(response.status, 200);
  const result = await response.json() as MarketSyncSummary;
  assert.equal(result.totalCompsInserted, 1);
  assert.ok(autopilot.getBuyBook().get('ptcg-api-tst-123'));
  assert.equal((await post(await serve(), {})).status, 501);
});

test('CLI sync smoke test returns JSON with disabled providers and zero errors', () => {
  const child = spawnSync(process.execPath, ['src/cli.ts', 'sync', '--db', ':memory:'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, POKEMON_TCG_API_KEY: '', PRICECHARTING_API_TOKEN: '', EBAY_INSIGHTS_ENABLED: 'false' },
    timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout) as MarketSyncSummary;
  assert.equal(result.errorCount, 0);
  assert.deepEqual(result.providers.map(provider => provider.enabled), [false, false, false]);
});
