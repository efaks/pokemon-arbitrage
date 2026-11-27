import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { installCatalogPack, listCatalogPacks } from '../src/catalog/catalogPacks.ts';
import { createConfig } from '../src/config.ts';
import { ArbitrageDatabase } from '../src/db/database.ts';
import type { CanonicalSku, InventoryItem } from '../src/domain/types.ts';
import { DisabledFulfillmentAdapter, EbayFulfillmentAdapter, SalesReconciler, SimulatedFulfillmentAdapter } from '../src/liquidation/ebayFulfillment.ts';
import { EbaySellInventoryAdapter } from '../src/liquidation/ebaySellerAdapter.ts';
import { InventoryManager } from '../src/liquidation/inventoryManager.ts';
import { FmvEngine } from '../src/valuation/fmvEngine.ts';

const nowIso = '2026-11-26T12:00:00.000Z';
const now = new Date(nowIso);
const photo = 'https://images.example.test/card.jpg';
const sealedSku: CanonicalSku = {
  id: 'sealed-151-bundle', name: 'Scarlet & Violet 151 Booster Bundle', assetClass: 'sealed',
  setName: 'Scarlet & Violet 151', setCode: 'SV3pt5', upc: '820650853210', language: 'EN', variant: 'standard',
  aliases: [], createdAt: nowIso, updatedAt: nowIso,
};
const item: InventoryItem = {
  id: 'bundle-1', orderId: 'purchase', skuId: sealedSku.id, skuName: sealedSku.name, assetClass: 'sealed',
  expectedCondition: 'SEALED', costBasisCents: 3000, expectedExitChannel: 'ebay', expectedFmvCents: 5400,
  predictedNetProfitCents: 1500, status: 'listed', listedChannel: 'ebay', externalListingId: '101',
  acquiredAt: nowIso, updatedAt: nowIso,
};

function openDb(t: TestContext): ArbitrageDatabase {
  const db = new ArbitrageDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function openLedger(t: TestContext) {
  const db = openDb(t);
  const config = createConfig({ cashBalanceCents: 10000 });
  const inventoryManager = new InventoryManager(db, new FmvEngine(), config);
  db.upsertSku(sealedSku);
  const listing = {
    listingId: 'buy-listing', listingUrl: 'https://shopping.example.test/buy-listing', listingTitle: sealedSku.name,
    source: 'mock_feed', skuId: sealedSku.id, skuName: sealedSku.name, assetClass: sealedSku.assetClass,
  } as const;
  db.saveDecision({
    ...listing, id: 'decision', action: 'auto_buy', intendedAction: 'auto_buy', operatingMode: 'live',
    matchConfidence: 1, warnings: [], reasons: [], anomalyFlagged: false, decidedAt: nowIso,
  });
  db.createOrderIdempotent({
    ...listing, id: item.orderId, idempotencyKey: 'purchase', decisionId: 'decision', status: 'approved', quantity: 2,
    askPriceCents: 6000, shippingCents: 0, taxCents: 0, landedCostCents: 6000, expectedNetProfitCents: 3000,
    expectedNetRoi: 0.5, recommendedExitChannel: 'ebay', decisionWarnings: [], createdAt: nowIso, updatedAt: nowIso,
  });
  return { db, config, inventoryManager };
}

test('cash reflects approvals, executions, fills, and the net proceeds of sold inventory', t => {
  const { db, config, inventoryManager } = openLedger(t);
  const cash = () => db.getPortfolioSnapshot(config, nowIso).cashBalanceCents;
  assert.equal(cash(), 4000);
  db.updateOrderStatus(item.orderId, 'executing');
  assert.equal(cash(), 4000);
  db.updateOrderStatus(item.orderId, 'filled');
  db.createInventoryItem(item);
  assert.equal(cash(), 4000);
  inventoryManager.recordSale(item.id, { exitChannel: 'ebay', soldPriceCents: 5000, exitFeesCents: 500, soldAt: nowIso });
  assert.equal(cash(), 8500);
  assert.equal(db.getDashboardMetrics(config, nowIso).portfolio.cashBalanceCents, 8500);
  assert.equal(db.getPortfolioSnapshot({ ...config, cashBalanceCents: 100 }).cashBalanceCents, 0);
});

const sellerSettings = {
  accessToken: 'test-token', refreshToken: '', sandbox: true,
  fulfillmentPolicyId: 'shipping', paymentPolicyId: 'payment', returnPolicyId: 'returns', merchantLocationKey: 'location',
};

test('eBay listings send sealed, raw and graded TCG aspects plus only valid HTTPS photos', async () => {
  const products: { aspects: Record<string, string[]>; imageUrls: string[] }[] = [];
  const adapter = new EbaySellInventoryAdapter({
    ...sellerSettings,
    fetchFn: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.includes('/inventory_item/')) {
        products.push(JSON.parse(String(init?.body)).product);
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/offer')) return Response.json({ offerId: 'offer' });
      if (path.endsWith('/publish')) return Response.json({ listingId: 'listing' });
      assert.fail(`Unexpected request to ${path}`);
    },
  });
  const raw: CanonicalSku = {
    ...sealedSku, id: 'raw-card', name: 'Charmander 004/165 Reverse Holo - Pokemon Card 151 (JP)',
    assetClass: 'raw', setName: 'Pokemon Card 151', setCode: 'SV2a', upc: undefined,
    cardNumber: '004/165', language: 'JP', variant: 'reverse_holo',
  };
  const graded: CanonicalSku = {
    ...raw, id: 'graded-card', name: 'Greninja ex 214/167 SIR (BGS 9.5)', assetClass: 'graded',
    cardNumber: '214/167', setName: 'Twilight Masquerade', setCode: 'SV06', language: 'EN',
    variant: 'sir', grader: 'BGS', grade: '9.5',
  };
  const fixtures = [
    { sku: sealedSku, condition: 'SEALED', aspects: {
      Game: ['Pokémon TCG'], Set: [sealedSku.setName], Language: ['English'],
      Configuration: ['Box'], Features: ['Factory Sealed'], UPC: [sealedSku.upc],
    } },
    { sku: raw, condition: 'NM', aspects: {
      Game: ['Pokémon TCG'], Set: [raw.setName], Language: ['Japanese'],
      'Card Name': ['Charmander'], 'Card Number': [raw.cardNumber], Finish: ['Reverse Holo'], Graded: ['No'],
    } },
    { sku: graded, condition: 'NM', aspects: {
      Game: ['Pokémon TCG'], Set: [graded.setName], Language: ['English'], 'Card Name': ['Greninja ex'],
      'Card Number': [graded.cardNumber], Finish: ['Holo'], Features: ['Special Illustration Rare'],
      Graded: ['Yes'], 'Professional Grader': ['BGS'], Grade: ['9.5'],
    } },
  ] as const;
  for (const { sku, condition } of fixtures) {
    const result = await adapter.publishListing({ ...item, skuName: sku.name, assetClass: sku.assetClass }, sku, {
      condition, priceCents: 5000, imageUrls: ['http://images.example.test/card.jpg', photo],
    });
    assert.equal(result.success, true, result.failureReason);
  }
  assert.deepEqual(products.map(product => product.aspects), fixtures.map(fixture => fixture.aspects));
  assert.deepEqual(products.map(product => product.imageUrls), [[photo], [photo], [photo]]);
});

test('eBay listing without an HTTPS image returns the exact error before network access', async () => {
  const adapter = new EbaySellInventoryAdapter({ ...sellerSettings, fetchFn: async () => assert.fail('Unexpected request') });
  assert.deepEqual(await adapter.publishListing(item, sealedSku, { priceCents: 5000 }), {
    success: false,
    failureReason: 'eBay publishing requires at least one HTTPS photo URL; pass imageUrls or set referenceImageUrl on the SKU',
  });
});

test('Fulfillment refreshes on a 401, filters unpaid and canceled orders, and parses sales by SKU or listing ID', async () => {
  let tokens = 0;
  let orderRequests = 0;
  const adapter = new EbayFulfillmentAdapter({
    accessToken: '', refreshToken: 'refresh', clientId: 'client', clientSecret: 'secret', sandbox: true,
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.host, 'api.sandbox.ebay.com');
      if (url.pathname === '/identity/v1/oauth2/token') {
        const data = new URLSearchParams(String(init?.body));
        assert.equal(data.get('grant_type'), 'refresh_token');
        assert.equal(data.get('scope'), 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly');
        return Response.json({ access_token: `token-${++tokens}`, expires_in: 7200 });
      }
      assert.equal(url.pathname, '/sell/fulfillment/v1/order');
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer token-${++orderRequests}`);
      assert.equal(url.searchParams.get('limit'), '8');
      assert.equal(url.searchParams.get('filter'), `creationdate:[${nowIso}..]`);
      if (orderRequests === 1) return new Response(null, { status: 401 });
      const amount = (value: string, currency = 'USD') => ({ value, currency });
      const paid = {
        orderId: 'sku-sale', orderPaymentStatus: 'PAID', creationDate: nowIso,
        lineItems: [{ sku: 'pa-bundle-1', lineItemCost: amount('45.99') }], totalMarketplaceFee: amount('6.91'),
      };
      return Response.json({ orders: [
        paid,
        { orderId: 'listing-sale', orderPaymentStatus: 'PAID', creationDate: nowIso, lineItems: [{ legacyItemId: '102' }],
          pricingSummary: { total: amount('50.00') }, paymentSummary: { totalDueSeller: amount('44.90') } },
        { ...paid, orderId: 'unpaid', orderPaymentStatus: 'PENDING' },
        { ...paid, orderId: 'canceled', cancelStatus: { cancelState: 'CANCELED' } },
        { ...paid, orderId: 'foreign-currency', lineItems: [{ legacyItemId: '104', lineItemCost: amount('50.00', 'EUR') }] },
        { ...paid, orderId: 'multi-line', totalMarketplaceFee: amount('0.05'), lineItems: [
          { sku: 'pa-line-1', lineItemCost: amount('1.00') }, { sku: 'pa-line-2', lineItemCost: amount('1.00') },
        ] },
      ] });
    },
  });
  assert.equal(adapter.isConfigured(), true);
  const orders = await adapter.fetchPaidOrders({ sinceIso: nowIso, limit: 8 });
  assert.deepEqual([tokens, orderRequests], [2, 2]);
  assert.deepEqual(orders.map(order => [
    order.externalOrderId, order.inventorySku, order.externalListingId, order.soldPriceCents, order.exitFeesCents,
  ]), [
    ['sku-sale', 'pa-bundle-1', undefined, 4599, 691],
    ['listing-sale', undefined, '102', 5000, 510],
    ['multi-line', 'pa-line-1', undefined, 100, 3],
    ['multi-line', 'pa-line-2', undefined, 100, 2],
  ]);
  assert.ok(orders.every(order => order.buyerPaid && order.soldAt === nowIso));
});

test('reconciliation records each sale once, isolates failures, and replenishes cash', async t => {
  const { db, config, inventoryManager } = openLedger(t);
  db.updateOrderStatus(item.orderId, 'filled');
  db.createInventoryItem(item);
  db.createInventoryItem({ ...item, id: 'bundle-2', externalListingId: '102' });
  const common = { soldAt: nowIso, buyerPaid: true };
  const bySku = { ...common, externalOrderId: 'sku-sale', inventorySku: 'pa-bundle-1', soldPriceCents: 5000, exitFeesCents: 500 };
  const byListing = { ...common, externalOrderId: 'listing-sale', externalListingId: '102', soldPriceCents: 6200, exitFeesCents: 620 };
  const adapter = new SimulatedFulfillmentAdapter([
    { ...bySku, externalOrderId: 'invalid-amount', soldPriceCents: 0.5 }, bySku, bySku, byListing,
    { ...common, externalOrderId: 'unmatched', externalListingId: '999', soldPriceCents: 3500 },
  ]);
  const reconciler = new SalesReconciler(db, inventoryManager, adapter);
  assert.equal(reconciler.isConfigured(), true);
  assert.equal(reconciler.getAdapter(), adapter);
  assert.equal(db.getPortfolioSnapshot(config, nowIso).cashBalanceCents, 4000);
  const first = await reconciler.reconcileSoldOrders({ sinceIso: nowIso, limit: 5 });
  assert.deepEqual(first, {
    adapterName: adapter.name, enabled: true, ordersFetched: 5, reconciledCount: 2, skippedCount: 2,
    reconciledInventoryIds: [item.id, 'bundle-2'], errors: ['invalid-amount: Sold price must be an integer number of cents (minimum 1)'],
  });
  const sold = db.listInventory('sold');
  assert.equal(sold.length, 2);
  assert.deepEqual(sold.map(entry => [entry.soldChannel, entry.realizedProfitCents, entry.soldAt]), [
    ['ebay', 2580, nowIso], ['ebay', 1500, nowIso],
  ]);
  assert.equal(db.getPortfolioSnapshot(config, nowIso).cashBalanceCents, 14080);

  adapter.orders = [bySku, byListing];
  const repeat = await reconciler.reconcileSoldOrders();
  assert.deepEqual([repeat.reconciledCount, repeat.skippedCount, repeat.errors], [0, 2, []]);
  const events = db.listAuditEvents().filter(event => event.eventType === 'inventory.sale_reconciled');
  assert.deepEqual(events.map(event => event.payload.externalOrderId), ['listing-sale', 'sku-sale']);
  assert.equal(db.getPortfolioSnapshot(config, nowIso).cashBalanceCents, 14080);
});

test('disabled fulfillment skips fetching and an adapter failure is reported in the summary', async t => {
  const { db, inventoryManager } = openLedger(t);
  const adapter = new DisabledFulfillmentAdapter();
  t.mock.method(adapter, 'fetchPaidOrders', async () => assert.fail('Disabled adapter must not fetch'));
  const disabled = new SalesReconciler(db, inventoryManager, adapter);
  assert.deepEqual(await disabled.reconcileSoldOrders(), {
    adapterName: adapter.name, enabled: false, ordersFetched: 0, reconciledCount: 0, skippedCount: 0,
    reconciledInventoryIds: [], errors: [],
  });
  const failing = new SimulatedFulfillmentAdapter();
  t.mock.method(failing, 'fetchPaidOrders', async () => { throw new Error('Fulfillment provider unavailable'); });
  assert.deepEqual((await new SalesReconciler(db, inventoryManager, failing).reconcileSoldOrders()).errors,
    ['Fulfillment provider unavailable']);
});

test('reconciliation rolls back a sale when its audit write fails and can retry', async t => {
  const { db, inventoryManager } = openLedger(t);
  db.updateOrderStatus(item.orderId, 'filled');
  db.createInventoryItem(item);
  const reconciler = new SalesReconciler(db, inventoryManager, new SimulatedFulfillmentAdapter([{
    externalOrderId: 'sale', inventorySku: 'pa-bundle-1', soldPriceCents: 5000, exitFeesCents: 500,
    soldAt: nowIso, buyerPaid: true,
  }]));
  const logAuditEvent = db.logAuditEvent.bind(db);
  const auditMock = t.mock.method(db, 'logAuditEvent', (eventType: string, payload?: Record<string, unknown>) => {
    if (eventType === 'inventory.sale_reconciled') throw new Error('Audit write failed');
    return logAuditEvent(eventType, payload);
  });
  assert.deepEqual((await reconciler.reconcileSoldOrders()).errors, ['sale: Audit write failed']);
  assert.equal(db.getInventoryItem(item.id)?.status, 'listed');
  assert.equal(db.listAuditEvents().some(event => event.eventType === 'inventory.sold'), false);

  auditMock.mock.restore();
  assert.equal((await reconciler.reconcileSoldOrders()).reconciledCount, 1);
  assert.equal(db.getInventoryItem(item.id)?.status, 'sold');
});

test('curated catalog installs three distinct expansion packs and is repeatable with no synthetic comps', t => {
  const db = openDb(t);
  const descriptors = listCatalogPacks();
  const byName = new Map(descriptors.map(pack => [pack.name, pack]));
  assert.equal(installCatalogPack(db, 'starter', now).skusUpserted, byName.get('starter')!.count);
  let total = db.listSkus().length;
  for (const pack of ['expanded_sealed', 'expanded_slabs', 'expanded_raw'] as const) {
    const count = byName.get(pack)!.count;
    assert.ok(count >= 20);
    total += count;
    assert.deepEqual(installCatalogPack(db, pack, now), { pack, skusUpserted: count, totalCatalogSkus: total });
  }
  const all = { pack: 'all_curated', skusUpserted: total, totalCatalogSkus: total };
  assert.equal(total, byName.get('all_curated')!.count);
  assert.ok(total - byName.get('starter')!.count >= 60);
  assert.deepEqual(installCatalogPack(db, 'all_curated', now), all);

  const installed = db.listSkus();
  const upcs = installed.flatMap(sku => sku.upc ?? []);
  assert.equal(new Set(installed.map(sku => sku.id)).size, total);
  assert.equal(new Set(upcs).size, upcs.length);
  assert.ok(installed.every(sku => db.getSoldComps(sku.id).length === 0));
  const fresh = openDb(t);
  assert.deepEqual(installCatalogPack(fresh, 'all_curated', now), all);
  assert.deepEqual(fresh.listSkus(), installed);
  const later = new Date('2026-11-27T12:00:00.000Z');
  assert.deepEqual(installCatalogPack(db, 'all_curated', later), all);
  assert.deepEqual(db.listSkus(), installed.map(sku => ({ ...sku, updatedAt: later.toISOString() })));
});
