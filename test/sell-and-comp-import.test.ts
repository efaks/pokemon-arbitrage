import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSystemRuntime } from '../src/cli.ts';
import type { SystemRuntime, SystemRuntimeOptions } from '../src/cli.ts';
import { ArbitrageDatabase } from '../src/db/database.ts';
import type { CanonicalSku, InventoryItem } from '../src/domain/types.ts';
import { AutopilotEngine } from '../src/engine/autopilot.ts';
import { BuyBook } from '../src/engine/buyBook.ts';
import { evaluateReadiness } from '../src/engine/readiness.ts';
import { DisabledSellerAdapter, EbaySellInventoryAdapter, SimulatedSellerAdapter } from '../src/liquidation/ebaySellerAdapter.ts';
import { InventoryManager } from '../src/liquidation/inventoryManager.ts';
import { createArbitrageServer } from '../src/server/httpServer.ts';
import { importSoldComps, parseSoldCompsCsv } from '../src/sync/compImporter.ts';
import type { ImportCompInput } from '../src/sync/compImporter.ts';
import { priceChartingFieldForSku } from '../src/sync/marketSync.ts';

const nowIso = '2026-11-26T12:00:00.000Z';
const sku: CanonicalSku = {
  id: 'wave8-card', name: 'Pikachu ex', assetClass: 'graded', grader: 'PSA', grade: '10',
  setName: 'Test Set', setCode: 'TST', language: 'EN', variant: 'standard', aliases: [],
  referenceImageUrl: 'https://images.example.test/pikachu.jpg', createdAt: nowIso, updatedAt: nowIso,
};
const item: InventoryItem = {
  id: 'item/1', orderId: 'order-1', skuId: sku.id, skuName: sku.name, assetClass: 'graded',
  expectedCondition: 'NM', expectedExitChannel: 'ebay', expectedFmvCents: 15_000, costBasisCents: 7500,
  predictedNetProfitCents: 4000, status: 'qc_passed', acquiredAt: nowIso, updatedAt: nowIso,
};
const sellerSettings = {
  fulfillmentPolicyId: 'shipping', paymentPolicyId: 'payment', returnPolicyId: 'return', merchantLocationKey: 'origin',
};
const tokenSettings = { accessToken: 'sell-token', refreshToken: '', ...sellerSettings };
const sealedSkuId = 'sealed-ssp-bb';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'arbitrage-wave8-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runtimeFor(t: TestContext, options: SystemRuntimeOptions = {}) {
  const runtime = createSystemRuntime({ dbPath: ':memory:', useMock: true, mode: 'live', quiet: true, ...options });
  t.after(() => runtime.db.close());
  return runtime;
}

async function acquireSealed(runtime: SystemRuntime): Promise<InventoryItem> {
  const listings = await runtime.connectors[0].fetchListings([]);
  const outcome = await new AutopilotEngine(runtime).ingestListingFastPath(
    listings.find(listing => listing.listingId === 'mock-ssp-bb-clean')!,
  );
  assert.equal(outcome.execution?.status, 'filled');
  return outcome.execution!.inventoryItem!;
}

test('PriceCharting maps only the requested grade tiers to their exact fields', () => {
  const field = (patch: Partial<CanonicalSku>) => priceChartingFieldForSku({ ...sku, ...patch });
  assert.equal(field({}), 'manual-only-price');
  assert.equal(field({ grader: 'BGS', grade: '10.0' }), 'bgs-10-price');
  assert.equal(field({ grader: 'CGC' }), 'condition-17-price');
  assert.equal(field({ grader: 'SGC' }), undefined);
  assert.equal(field({ grader: undefined }), undefined);
  assert.equal(field({ grade: '6.5' }), undefined);
  for (const [grade, expected] of [
    ['9.5', 'box-only-price'], ['9', 'graded-price'], ['8.5', 'new-price'], ['8', 'new-price'],
    ['7.5', 'cib-price'], ['7', 'cib-price'],
  ]) assert.equal(field({ grade }), expected);
  assert.equal(field({ assetClass: 'raw' }), 'loose-price');
  assert.equal(field({ assetClass: 'sealed' }), 'new-price');
});

test('CSV and JSON historical sale batches deduplicate, reject invalid rows, and activate FMV and Buy Book', t => {
  const { db, fmvEngine, config } = runtimeFor(t, { seedCatalog: false });
  const buyBook = new BuyBook();
  db.upsertSku(sku);
  const options = { buyBook, fmvEngine, config, nowIso };
  buyBook.refresh(db, fmvEngine, config, nowIso);
  assert.equal(buyBook.get(sku.id)?.isStale, true);

  const csv = '\uFEFFskuId,source,soldPriceUsd,shippingUsd,condition,grader,grade,soldAt,id\r\n' +
    '\r\n"wave8-card","ebay",149.25,0.75,NM,PSA,10,2026-11-26T11:00:00Z,"sale, ""one"""\r\n' +
    'wave8-card,ebay,150,,,,,2026-11-26T10:00:00Z,\r\n';
  const parsed = parseSoldCompsCsv(csv);
  assert.equal(parsed[0].id, 'sale, "one"');
  assert.equal(parsed[0].soldPriceCents, 14_925);
  assert.equal(parsed[0].shippingCents, 75);
  assert.throws(() => parseSoldCompsCsv(csv + '"unterminated'), /Unterminated quote/);
  const jsonComp: ImportCompInput = { skuId: sku.id, source: 'tcgplayer', soldPriceCents: 15_000, soldAt: nowIso };
  const invalid = [
    { skuId: 'missing' }, { source: 'unknown' }, { condition: 'invalid' }, { soldPriceCents: 1.5 },
    { shippingCents: -1 }, { soldAt: '2026-02-30T10:00:00Z' }, { soldAt: 'November 26, 2026' },
    { soldPriceCents: Number.MAX_SAFE_INTEGER, shippingCents: 1 },
  ].map(patch => ({ ...jsonComp, ...patch }) as ImportCompInput);
  const result = importSoldComps(db, [...parsed, jsonComp, ...invalid], options);
  assert.deepEqual({ ...result, errors: result.errors.length }, {
    received: 11, inserted: 3, duplicatesSkipped: 0, rejected: 8, errors: 8,
  });
  const comps = db.getSoldComps(sku.id);
  assert.ok(comps.every(comp => comp.totalPriceCents === 15_000 && comp.grader === 'PSA' && comp.grade === '10'));
  assert.ok(comps.some(comp => /^imported-[a-f0-9]{24}$/.test(comp.id)));
  assert.equal(fmvEngine.evaluate(sku, comps, config, { nowIso }).isStale, false);
  assert.equal(buyBook.get(sku.id)?.isStale, false);
  assert.equal(buyBook.get(sku.id)?.fmvCents, 15_000);
  assert.deepEqual(importSoldComps(db, [...parsed, { ...jsonComp, soldAt: '2026-11-26T07:00:00-05:00' }], options), {
    received: 3, inserted: 0, duplicatesSkipped: 3, rejected: 0, errors: [],
  });
  assert.equal(db.listAuditEvents(1)[0].eventType, 'market.comps_imported');
});

test('opening a pre-Wave-8 SQLite database preserves the inventory row and adds external listing columns', async t => {
  const dbPath = join(tempDir(t), 'legacy.sqlite');
  const runtime = createSystemRuntime({ dbPath, useMock: true, mode: 'live', quiet: true });
  let existing: InventoryItem;
  try {
    const acquired = await acquireSealed(runtime);
    existing = runtime.db.getInventoryItem(acquired.id)!;
  } finally {
    runtime.db.close();
  }

  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`ALTER TABLE inventory_items DROP COLUMN external_offer_id;
      ALTER TABLE inventory_items DROP COLUMN external_listing_id;
      ALTER TABLE inventory_items DROP COLUMN external_listing_url;`);
  } finally {
    legacy.close();
  }
  const upgraded = new ArbitrageDatabase(dbPath);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.getInventoryItem(existing.id), existing);
  upgraded.updateInventoryItem(existing.id, {
    externalOfferId: 'offer', externalListingId: 'listing', externalListingUrl: 'https://www.ebay.com/itm/listing',
  });
  const reopened = new ArbitrageDatabase(dbPath);
  t.after(() => reopened.close());
  assert.equal(reopened.getInventoryItem(existing.id)?.externalOfferId, 'offer');
  assert.equal(reopened.getInventoryItem(existing.id)?.externalListingId, 'listing');
  assert.equal(reopened.getInventoryItem(existing.id)?.externalListingUrl, 'https://www.ebay.com/itm/listing');
});

test('eBay Sell Inventory publishes, reprices, and withdraws with the official HTTP payloads', async () => {
  const calls: {
    method?: string; path: string; body: {
      condition: string; conditionDescriptors: unknown; product: { imageUrls: string[] }; marketplaceId: string;
      categoryId: string; format: string; pricingSummary: { price: unknown }; listingPolicies: unknown;
    };
  }[] = [];
  let rejectPrice = false;
  const adapter = new EbaySellInventoryAdapter({
    ...tokenSettings, sandbox: true,
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.host, 'api.sandbox.ebay.com');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Authorization'), 'Bearer sell-token');
      assert.equal(headers.get('Content-Language'), 'en-US');
      const path = url.pathname.replace('/sell/inventory/v1', '');
      calls.push({ method: init?.method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/offer') return Response.json({ offerId: 'offer/1' }, { status: 201 });
      if (path.endsWith('/publish')) return Response.json({ listingId: '5678' });
      if (path === '/bulk_update_price_quantity') {
        return Response.json({ responses: [{ statusCode: rejectPrice ? 400 : 200, offerId: 'offer/1', sku: 'pa-item/1' }] });
      }
      return new Response(null, { status: 204 });
    },
  });
  const published = await adapter.publishListing(item, sku, { priceCents: 15_999 });
  assert.deepEqual(published, {
    success: true, externalOfferId: 'offer/1', externalListingId: '5678',
    externalListingUrl: 'https://www.sandbox.ebay.com/itm/5678',
  });
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ['PUT', '/inventory_item/pa-item%2F1'], ['POST', '/offer'], ['POST', '/offer/offer%2F1/publish'],
  ]);
  assert.equal(calls[0].body.condition, 'LIKE_NEW');
  assert.deepEqual(calls[0].body.conditionDescriptors, [
    { name: '27501', values: ['275010'] }, { name: '27502', values: ['275020'] },
  ]);
  assert.deepEqual(calls[0].body.product.imageUrls, [sku.referenceImageUrl]);
  assert.equal(calls[1].body.categoryId, '183454');
  assert.equal(calls[1].body.format, 'FIXED_PRICE');
  assert.equal(calls[1].body.marketplaceId, 'EBAY_US');
  assert.deepEqual(calls[1].body.pricingSummary.price, { value: '159.99', currency: 'USD' });
  assert.deepEqual(calls[1].body.listingPolicies, {
    fulfillmentPolicyId: 'shipping', paymentPolicyId: 'payment', returnPolicyId: 'return',
  });
  const listed = { ...item, ...published };
  assert.deepEqual(await adapter.updateListingPrice(listed, 15_301), { success: true });
  assert.deepEqual(calls[3].body, { requests: [{
    sku: 'pa-item/1', offers: [{ offerId: 'offer/1', availableQuantity: 1, price: { value: '153.01', currency: 'USD' } }],
  }] });
  rejectPrice = true;
  assert.match((await adapter.updateListingPrice(listed, 14_999)).failureReason!, /status 400/);
  assert.deepEqual(await adapter.withdrawListing(listed), { success: true });
  assert.deepEqual(calls.slice(-1).map(({ method, path }) => [method, path]), [['POST', '/offer/offer%2F1/withdraw']]);
});

test('eBay Sell Inventory refreshes on a 401 and guards missing policies before fetching', async () => {
  let tokenRequests = 0;
  let withdrawRequests = 0;
  const adapter = new EbaySellInventoryAdapter({
    ...sellerSettings, accessToken: '', clientId: 'app', clientSecret: 'secret', refreshToken: 'refresh', sandbox: false,
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/identity/v1/oauth2/token') {
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.get('scope'), 'https://api.ebay.com/oauth/api_scope/sell.inventory');
        return Response.json({ access_token: `token-${++tokenRequests}`, expires_in: 7200 });
      }
      const attempt = ++withdrawRequests;
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer token-${attempt}`);
      return new Response(null, { status: attempt === 1 ? 401 : 204 });
    },
  });
  assert.equal((await adapter.withdrawListing({ ...item, externalOfferId: 'offer' })).success, true);
  assert.deepEqual([tokenRequests, withdrawRequests], [2, 2]);
  const missingPolicy = new EbaySellInventoryAdapter({
    ...tokenSettings, paymentPolicyId: ' ', fetchFn: async () => assert.fail('Missing-policy call must stay offline'),
  });
  assert.equal(missingPolicy.isConfigured(), false);
  assert.match((await missingPolicy.publishListing(item, sku, { priceCents: 150 })).failureReason!, /listing policies/);
});

test('eBay reuses a retained unpublished offer after withdrawal', async () => {
  const steps: string[] = [];
  const adapter = new EbaySellInventoryAdapter({
    ...tokenSettings,
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      const step = `${init?.method} ${url.pathname.replace('/sell/inventory/v1', '')}`;
      steps.push(step);
      if (step === 'POST /offer') return new Response(null, { status: 400 });
      if (step === 'GET /offer') {
        assert.equal(url.searchParams.get('sku'), 'pa-item/1');
        return Response.json({ offers: [{
          offerId: 'prior-offer', sku: 'pa-item/1', marketplaceId: 'EBAY_US', format: 'FIXED_PRICE', status: 'UNPUBLISHED',
        }] });
      }
      if (step === 'PUT /offer/prior-offer') {
        assert.equal(JSON.parse(String(init?.body)).pricingSummary.price.value, '152.00');
      }
      if (step === 'POST /offer/prior-offer/publish') return Response.json({ listingId: 'second-listing' });
      return new Response(null, { status: 204 });
    },
  });
  const result = await adapter.publishListing(item, sku, { priceCents: 15_200 });
  assert.equal(result.externalListingId, 'second-listing');
  assert.deepEqual(steps, [
    'PUT /inventory_item/pa-item%2F1', 'POST /offer', 'GET /offer',
    'PUT /offer/prior-offer', 'POST /offer/prior-offer/publish',
  ]);
});

test('InventoryManager publishes at FMV, syncs reprices, and clears active fields only after withdrawal', async t => {
  const runtime = runtimeFor(t);
  const { inventoryManager, db, fmvEngine, config } = runtime;
  const acquired = await acquireSealed(runtime);
  await assert.rejects(inventoryManager.publishListing(acquired.id), /must pass QC/);
  inventoryManager.recordIntakeQc(acquired.id, { passed: true, actualCondition: 'SEALED' });
  const fmv = inventoryManager.recommendExit(acquired.id).expectedFmvCents;
  const listed = await inventoryManager.publishListing(acquired.id, { channel: 'ebay' });
  assert.equal(listed.listedPriceCents, fmv);
  assert.equal(listed.externalOfferId, `sim-offer-${acquired.id}`);
  const failing = new InventoryManager(db, fmvEngine, config, new SimulatedSellerAdapter({
    [acquired.id]: { repriceFailure: 'Price rejected', withdrawFailure: 'Withdrawal rejected' },
  }));
  await assert.rejects(failing.syncReprice(acquired.id, fmv - 100), /Price rejected/);
  await assert.rejects(failing.withdrawListing(acquired.id), /Withdrawal rejected/);
  assert.deepEqual(db.getInventoryItem(acquired.id), listed);
  assert.equal((await inventoryManager.syncReprice(acquired.id, fmv - 100)).listedPriceCents, fmv - 100);
  const withdrawn = await inventoryManager.withdrawListing(acquired.id, 'Inspect again');
  assert.equal(withdrawn.status, 'qc_passed');
  for (const key of ['externalOfferId', 'externalListingId', 'externalListingUrl', 'listedPriceCents', 'listedChannel'] as const) {
    assert.equal(withdrawn[key], undefined);
  }
  assert.equal(db.listAuditEvents(1)[0].payload.externalOfferId, listed.externalOfferId);
  const local = await inventoryManager.publishListing(acquired.id, { pushLive: false });
  assert.equal(local.externalOfferId, undefined);
  assert.equal(local.status, 'listed');
});

test('live repricing auto-publishes and pushes price changes, with per-item failures and retries', async t => {
  const runtime = runtimeFor(t);
  const acquired = await acquireSealed(runtime);
  const prices: number[] = [];
  let rejectPrice = true;
  const adapter = new SimulatedSellerAdapter();
  t.mock.method(adapter, 'updateListingPrice', async (updated: InventoryItem, cents: number) => {
    assert.equal(updated.externalOfferId, `sim-offer-${updated.id}`);
    prices.push(cents);
    return rejectPrice ? { success: false, failureReason: 'Retryable failure' } : { success: true };
  });
  const { db, fmvEngine, config } = runtime;
  config.exitFeeSchedules.ebay.percentFee = 0.04;
  runtime.inventoryManager = new InventoryManager(db, fmvEngine, config, adapter);
  const engine = new AutopilotEngine(runtime, { autopilotConfig: { autoPublishListings: true } });
  runtime.inventoryManager.recordIntakeQc(acquired.id, { passed: true, actualCondition: 'SEALED' });
  assert.equal(engine.recommendFulfillmentRoute(acquired.id).channel, 'ebay');
  assert.equal((await engine.runLiveRepricingCycle()).repricedCount, 1);
  const original = db.getInventoryItem(acquired.id)!;
  assert.match(original.externalOfferId!, /^sim-offer-/);
  db.updateInventoryItem(acquired.id, { acquiredAt: new Date(Date.now() - 14 * 86_400_000).toISOString() });
  assert.equal(engine.runRepricingCycle().repricedCount, 0);
  const failed = await engine.runLiveRepricingCycle();
  assert.equal(failed.repricedCount, 0);
  assert.match(failed.errors?.[0] ?? '', /Retryable failure/);
  assert.equal(db.getInventoryItem(acquired.id)?.listedPriceCents, original.listedPriceCents);
  rejectPrice = false;
  assert.equal((await engine.runLiveRepricingCycle()).repricedCount, 1);
  assert.equal(prices.length, 2);
  assert.equal(prices[0], prices[1]);
  assert.equal(db.getInventoryItem(acquired.id)?.listedPriceCents, prices[1]);
});

test('readiness reports mock, local-only, static eBay, and OAuth sell capabilities', t => {
  const runtime = runtimeFor(t);
  assert.equal(evaluateReadiness(runtime).sellCapability, 'simulated');
  assert.equal(evaluateReadiness(runtime).readyForLiveAutoSell, true);
  const { db, fmvEngine, config } = runtime;
  const check = (adapter: DisabledSellerAdapter | EbaySellInventoryAdapter) => evaluateReadiness({
    ...runtime, useMock: false, inventoryManager: new InventoryManager(db, fmvEngine, config, adapter),
  });
  const local = check(new DisabledSellerAdapter());
  assert.equal(local.sellCapability, 'local_only');
  assert.equal(local.readyForLiveAutoSell, false);
  assert.match(local.warnings.join(' '), /Selling is local only/);
  assert.equal(check(new EbaySellInventoryAdapter(tokenSettings)).sellCapability, 'ebay_sell_static_token');
  const oauth = new EbaySellInventoryAdapter({ ...sellerSettings, clientId: 'app', clientSecret: 'secret', refreshToken: 'refresh' });
  assert.equal(check(oauth).sellCapability, 'ebay_sell_oauth_live');
  assert.equal(check(oauth).readyForLiveAutoSell, true);
  db.setOperatingMode('shadow');
  assert.equal(check(oauth).readyForLiveAutoSell, false);
});

test('HTTP imports sold comps and publishes and withdraws inventory', async t => {
  const runtime = runtimeFor(t);
  const acquired = await acquireSealed(runtime);
  runtime.inventoryManager.recordIntakeQc(acquired.id, { passed: true, actualCondition: 'SEALED' });
  const autopilot = new AutopilotEngine(runtime);
  const server = createArbitrageServer({ ...runtime, autopilot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post('/api/comps/import', {})).status, 400);
  const response = await post('/api/comps/import', {
    csv: `skuId,source,soldPriceCents,soldAt\n${sealedSkuId},ebay,16601,${nowIso}`,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).inserted, 1);
  const publish = await post(`/api/inventory/${acquired.id}/publish`, { channel: 'ebay', listedPriceCents: 18_000 });
  assert.equal(publish.status, 200);
  assert.equal((await publish.json()).externalOfferId, `sim-offer-${acquired.id}`);
  const withdraw = await post(`/api/inventory/${acquired.id}/withdraw`, { reason: 'Inventory check' });
  assert.equal(withdraw.status, 200);
  assert.equal((await withdraw.json()).status, 'qc_passed');
});

test('CLI import-comps accepts both CSV and JSON and prints the deduplicated result', t => {
  const dir = tempDir(t);
  const dbPath = join(dir, 'import.sqlite');
  const runtime = createSystemRuntime({ dbPath, useMock: true, seedCatalog: false, quiet: true });
  runtime.db.upsertSku(sku);
  runtime.db.close();
  const csv = join(dir, 'comps.csv');
  const json = join(dir, 'comps.json');
  writeFileSync(csv, `skuId,source,soldPriceUsd,soldAt\n${sku.id},ebay,150.25,${nowIso}\n`);
  writeFileSync(json, JSON.stringify([{ skuId: sku.id, source: 'ebay', soldPriceCents: 15_025, soldAt: nowIso }]));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (file: string) => {
    const result = spawnSync(process.execPath, [cli, 'import-comps', '--file', file, '--db', dbPath], {
      encoding: 'utf8', env: { ...process.env, ARBITRAGE_SKIP_DOTENV: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(run(csv), { received: 1, inserted: 1, duplicatesSkipped: 0, rejected: 0, errors: [] });
  assert.deepEqual(run(json), { received: 1, inserted: 0, duplicatesSkipped: 1, rejected: 0, errors: [] });
});
