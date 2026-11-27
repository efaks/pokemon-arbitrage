import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSystemRuntime } from '../src/cli.ts';
import type { SystemRuntimeOptions } from '../src/cli.ts';
import type { SupplyConnector } from '../src/connectors/base.ts';
import type { CanonicalSku, RawListing, SoldComp } from '../src/domain/types.ts';
import { detectBuylistFloorArbitrage, evaluateRawToGradeEv, normalizeMisspelledListing } from '../src/engine/alphaSignals.ts';
import { AutopilotEngine } from '../src/engine/autopilot.ts';
import { BuyBook } from '../src/engine/buyBook.ts';
import { createArbitrageServer } from '../src/server/httpServer.ts';
import { calculateNetProfit, evaluateExitChannels } from '../src/valuation/profitCalculator.ts';

const dayMs = 86_400_000;
const nowIso = '2026-11-26T12:00:00.000Z';
const box: CanonicalSku = {
  id: 'test-box', name: 'Test Set Booster Box', assetClass: 'sealed', setName: 'Test Set', setCode: 'TEST',
  upc: '123456789123', language: 'EN', variant: 'standard', aliases: [], createdAt: nowIso, updatedAt: nowIso,
};
const candidate: RawListing = {
  listingId: 'test-listing', title: box.name, source: 'mock_feed', description: '', upc: box.upc,
  url: 'https://listings.example.test/test-listing', priceCents: 9500, shippingCents: 0, quantity: 1,
  currency: 'USD', imageUrls: [], supportsAutoCheckout: true, listedAt: nowIso, fetchedAt: nowIso,
  seller: { sellerId: 'seller', username: 'Trusted Seller', feedbackScore: 1000,
    positivePercent: 100, accountAgeDays: 1200, returnsAccepted: true },
};

function setup(t: TestContext, options: SystemRuntimeOptions = {}) {
  const runtime = createSystemRuntime({
    dbPath: ':memory:', useMock: true, quiet: true, mode: 'live', ...options,
    configOverrides: { dailySpendCapCents: 150_000, ...options.configOverrides },
  });
  t.after(() => runtime.db.close());
  return { ...runtime, autopilot: new AutopilotEngine(runtime) };
}

function comps(sku: CanonicalSku, prices: [number, number][]): SoldComp[] {
  return prices.map(([age, cents], index) => ({
    id: `${sku.id}-${age}-${index}`, skuId: sku.id, source: 'ebay', soldPriceCents: cents,
    shippingCents: 0, totalPriceCents: cents, condition: sku.assetClass === 'sealed' ? 'SEALED' : 'NM',
    soldAt: new Date(Date.parse(nowIso) - age * dayMs).toISOString(),
  }));
}

function crashingComps(): [number, number][] {
  return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30].map(age => [age, age <= 10 ? 16_000 : 20_000]);
}

test('Buy Book computes exact cent ceilings, priorities, and comparable-sale momentum', t => {
  const { db, config, fmvEngine } = setup(t, { seedCatalog: false });
  const standard = { ...box, id: 'standard-box', upc: undefined };
  const cold = { ...box, id: 'cold-box', upc: undefined };
  for (const sku of [box, standard, cold]) db.upsertSku(sku);
  db.insertSoldComps(comps(box, Array.from({ length: 10 }, (_, i) => [i + 1, 20_000])));
  db.insertSoldComps(comps(standard, [[1, 8000], [2, 8000], [3, 8000], [4, 8000]]));
  db.insertSoldComps(comps(cold, [[40, 2000], [50, 2000]]));
  const book = new BuyBook();
  assert.equal(book.refresh(db, fmvEngine, config, nowIso).length, 3);
  const entry = book.getByUpc(box.upc!);
  assert.ok(entry);
  assert.equal(entry.fmvCents, 20_000);
  assert.equal(entry.anomalyFloorAskCents, 8000);
  assert.deepEqual(book.list({ tier: 'hot' }).map(sku => sku.skuId), [box.id]);
  assert.deepEqual(book.list({ tier: 'standard' }).map(sku => sku.skuId), [standard.id]);
  assert.deepEqual(book.list({ tier: 'cold' }).map(sku => sku.skuId), [cold.id]);
  const qualifies = (ask: number, channel?: 'buylist') => {
    const listing = { ...candidate, priceCents: ask };
    const exit = channel ? calculateNetProfit(listing, entry.fmvCents, box.assetClass, channel, config)
      : evaluateExitChannels(listing, entry.fmvCents, box.assetClass, config).bestExit;
    return exit.netProfitCents >= config.minNetProfitCents && exit.netRoi >= config.minNetRoi;
  };
  for (const [limit, channel] of [[entry.maxAutoBuyAskCents, undefined], [entry.buylistFloorAskCents, 'buylist']] as const) {
    assert.ok(limit > 0);
    assert.equal(qualifies(limit, channel), true);
    assert.equal(qualifies(limit + 1, channel), false);
  }
  assert.equal(book.get(cold.id)?.maxAutoBuyAskCents, 0);
  assert.equal(book.quickScreen(box.id, entry.maxAutoBuyAskCents).eligible, true);
  assert.equal(book.quickScreen(box.id, entry.maxAutoBuyAskCents, 1).eligible, false);
  assert.equal(book.quickScreen(box.id, entry.buylistFloorAskCents).isBuylistFloorArb, true);
  assert.equal(book.quickScreen(box.id, 7999).eligible, false);
  assert.equal(book.quickScreen('missing', 100).found, false);

  const crash = { ...box, id: 'crash-box', upc: undefined };
  db.upsertSku(crash);
  db.insertSoldComps(comps(crash, crashingComps()));
  book.refresh(db, fmvEngine, config, nowIso);
  assert.equal(book.get(crash.id)?.momentumPct, -0.20);
  assert.deepEqual(book.list({ momentum: 'falling_knife' }).map(sku => sku.skuId), [crash.id]);
  assert.equal(book.quickScreen(crash.id, 9500).isFallingKnife, true);
});

test('known spelling and card numbers are recovered before entity resolution', async t => {
  const { resolver, db } = setup(t);
  for (const [title, expectedSku, expectedNumber] of [
    ['Charzard ex 199 165 SIR Pokmon 151 NM', 'raw-en-sv3pt5-199', '199/165'],
    ['Evolving Skys Boster Box', 'sealed-evs-bb', undefined],
    ['Umbron VMAX 215 203 PSA 10', 'graded-psa10-swsh07-215', '215/203'],
  ] as const) {
    const original = { ...candidate, title, upc: undefined, metadata: { fixture: true } };
    const { listing, recovery } = normalizeMisspelledListing(original);
    assert.equal(original.title, title);
    assert.deepEqual(listing.metadata, original.metadata);
    assert.ok(recovery.recovered);
    assert.equal(recovery.originalTitle, title);
    assert.deepEqual(recovery.extractedCardNumbers, expectedNumber ? [expectedNumber] : []);
    assert.equal((await resolver.resolve(listing, db.listSkus())).skuId, expectedSku);
  }
  const overlap = normalizeMisspelledListing({ ...candidate, title: '1 199 165, 006-165, 155 160' });
  assert.equal(overlap.listing.title, '1 199/165, 006/165, 155 160');
});

test('grading EV includes tax, grading fee, and whole-cent proceeds for every outcome', async t => {
  const { db, config, autopilot, connectors } = setup(t);
  const sku = db.getSku('raw-en-sv3pt5-199')!;
  const all = db.listSkus();
  const book = autopilot.getBuyBook();
  const listing = (await connectors[0].fetchListings(all)).find(item => item.listingId === 'mock-zard-raw-nm')!;
  const ev = evaluateRawToGradeEv(sku, listing, all, book, config, {
    gradingFeeCents: 2000, probTopGrade: 0.50, probRunnerUpGrade: 0.25,
  });
  assert.ok(ev?.viable);
  assert.equal(ev.gradedSkuId, 'graded-psa10-sv3pt5-199');
  const proceeds = (fmv: number, assetClass: 'raw' | 'graded') =>
    evaluateExitChannels(listing, fmv, assetClass, config).bestExit.netProceedsCents;
  const expectedProceeds = Math.round(0.5 * proceeds(ev.gradedFmvCents, 'graded') +
    0.25 * proceeds(Math.round(ev.gradedFmvCents * 0.55), 'graded') +
    0.25 * proceeds(book.get(sku.id)!.fmvCents, 'raw'));
  assert.equal(ev.expectedGradedProceedsCents, expectedProceeds);
  assert.equal(ev.rawLandedCostCents, 14040);
  assert.equal(ev.expectedGradingProfitCents, expectedProceeds - 16040);
  assert.equal(ev.expectedGradingRoi, ev.expectedGradingProfitCents / 16040);
  assert.equal(evaluateRawToGradeEv(sku, { ...listing, priceCents: 100_000 }, all, book, config)?.viable, false);
  assert.equal(evaluateRawToGradeEv(sku, listing, [], book, config), undefined);
  assert.equal(evaluateRawToGradeEv(box, listing, all, book, config), undefined);
  assert.throws(() => evaluateRawToGradeEv(sku, listing, all, book, config, { probTopGrade: 0.9 }), /probabilities/);

  const signal = detectBuylistFloorArbitrage({ ...listing, priceCents: 8500 }, 'raw', 20_000, config);
  assert.equal(signal.isBuylistFloorArb, true);
  assert.equal(signal.buylistBreakdown.exitChannel, 'buylist');
  assert.equal(detectBuylistFloorArbitrage(listing, 'raw', 20_000, config).isBuylistFloorArb, false);
});

test('the momentum guard suppresses an otherwise eligible purchase and persists the reason', async t => {
  const runtime = setup(t, { seedCatalog: false });
  const { db, pipeline, autopilot } = runtime;
  db.upsertSku(box);
  db.insertSoldComps(comps(box, crashingComps()));
  assert.equal((await pipeline.evaluateListing(candidate, { nowIso })).decision.action, 'auto_buy');
  const result = await autopilot.ingestListingFastPath(candidate, { nowIso });
  assert.equal(result.decision?.action, 'skip');
  assert.equal(result.decision?.intendedAction, 'auto_buy');
  assert.equal(result.execution?.status, 'skipped');
  assert.match(db.listDecisions()[0].reasons[0], /falling knife/);
  assert.equal(autopilot.getTelemetry().snapshot(db).fallingKnifeBlockedCount, 1);
  assert.deepEqual(db.listOrders(), []);
  const disabled = new AutopilotEngine(runtime, { autopilotConfig: { suppressFallingKnife: false } });
  assert.equal((await disabled.ingestListingFastPath(candidate, { nowIso, skipDeduplication: true })).execution?.status, 'filled');
});

test('repeated checkout failures throttle subsequent auto-buy decisions', async t => {
  const failures = Object.fromEntries([0, 1, 2].map(i => [`failure-${i}`, { failureReason: 'Declined' }]));
  const { autopilot, db } = setup(t, { seedCatalog: false, simulationOverrides: failures });
  db.upsertSku(box);
  db.insertSoldComps(comps(box, crashingComps().map(([age]) => [age, 16_000])));
  for (const listingId of Object.keys(failures)) {
    assert.equal((await autopilot.ingestListingFastPath({ ...candidate, listingId }, { nowIso })).execution?.status, 'failed');
  }
  const blocked = await autopilot.ingestListingFastPath(candidate, { nowIso });
  assert.match(blocked.decision?.reasons[0] ?? '', /Source auto-throttled/);
  assert.equal(blocked.execution?.status, 'skipped');
  assert.equal(autopilot.getTelemetry().isSourceThrottled(db, 'ebay').throttled, false);
  const telemetry = autopilot.getTelemetry().snapshot(db);
  assert.equal(telemetry.missRate, 1);
  assert.equal(telemetry.sources[0].failed, 3);
});

test('source throttling uses persisted sales and realized profit per source', async t => {
  const runtime = setup(t, { seedCatalog: false });
  const { autopilot, db, inventoryManager } = runtime;
  db.upsertSku(box);
  db.insertSoldComps(comps(box, crashingComps().map(([age]) => [age, 16_000])));
  for (const i of [0, 1, 2]) {
    const fill = await autopilot.ingestListingFastPath({ ...candidate, listingId: `sale-${i}` }, { nowIso });
    assert.equal(fill.execution?.status, 'filled');
    inventoryManager.recordSale(fill.execution!.inventoryItem!.id, { exitChannel: 'buylist', soldPriceCents: 1, exitFeesCents: 0 });
  }
  const telemetry = new AutopilotEngine(runtime).getTelemetry();
  assert.match(telemetry.isSourceThrottled(db, 'mock_feed').reason ?? '', /Negative realized P&L/);
  assert.equal(telemetry.isSourceThrottled(db, 'ebay').throttled, false);
  const stats = telemetry.snapshot(db).sources[0];
  assert.equal(stats.filled, 3);
  assert.equal(stats.realizedProfitCents, 3 * (1 - 10_260));
});

test('priority polling starts enabled connectors concurrently and records circuit breaker state', async t => {
  const { autopilot, db } = setup(t, { seedCatalog: false, configOverrides: { circuitBreakerMaxErrorsPerWindow: 1 } });
  db.upsertSku(box);
  db.upsertSku({ ...box, id: 'cold', upc: undefined });
  db.insertSoldComps(comps(box, Array.from({ length: 10 }, (_, i) => [i + 1, 16_000])));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const targets: string[][] = [];
  const connector: SupplyConnector = {
    name: 'slow', source: 'mock_feed', isEnabled: () => true, supportsAutoCheckout: true, pollIntervalMs: 60_000,
    async fetchListings(skus) {
      targets.push(skus.map(sku => sku.id));
      await gate;
      return [candidate];
    },
  };
  const summary = autopilot.runConcurrentPriorityCycle({ tier: 'hot', nowIso, connectors: [connector, {
    ...connector, name: 'failed',
    async fetchListings(skus) {
      targets.push(skus.map(sku => sku.id));
      release();
      throw new Error('Feed unreachable');
    },
  }] });
  const result = await summary;
  assert.deepEqual(targets, [[box.id], [box.id]]);
  assert.equal(result.errorCount, 1);
  assert.match(result.errors[0], /failed: Feed unreachable/);
  assert.equal(result.killSwitchTriggered, true);
  assert.equal(result.skippedCount, 1);
  assert.equal(db.getSystemState().lastScanAt, nowIso);
  assert.deepEqual(db.listOrders(), []);
  await autopilot.runConcurrentPriorityCycle({ tier: 'hot', nowIso, connectors: [connector] });
  assert.equal(db.getSystemState().consecutiveErrors, 0);
});

test('triage approves eligible raw and sealed orders and holds anomalies, retailers, and orders above cap', async t => {
  const { autopilot, db } = setup(t, { mode: 'hitl' });
  await autopilot.runConcurrentPriorityCycle();
  db.setKillSwitch(true);
  assert.equal((await autopilot.runAutonomousTriage()).skippedReason, 'Kill switch engaged');
  db.setKillSwitch(false);
  const triage = await autopilot.runAutonomousTriage({ maxApproveCents: 20_000 });
  const order = (listingId: string) => db.listOrders(undefined, -1).find(item => item.listingId === listingId);
  assert.equal(triage.approvedCount, 2);
  for (const id of ['mock-zard-raw-nm', 'mock-ssp-bb-clean']) assert.equal(order(id)?.status, 'filled');
  for (const id of [
    'mock-pre-etb-retailer', 'mock-evs-bb-anomaly', 'mock-lugia-cgc10-clean', 'mock-costco-151-tins', 'mock-pc-pre-etb',
  ]) {
    assert.equal(order(id)?.status, 'pending_hitl');
  }
  const second = await autopilot.runAutonomousTriage({ maxApproveCents: 20_000, autoRejectAnomalies: true });
  assert.equal(second.rejectedCount, 2);
  assert.equal(order('mock-evs-bb-anomaly')?.status, 'rejected');
  assert.equal(order('mock-pc-pre-etb')?.status, 'rejected');
  assert.equal(order('mock-costco-151-tins')?.status, 'pending_hitl');
});

test('triage rechecks momentum after a queued order and requires raw photo evidence', async t => {
  const { autopilot, db, connectors } = setup(t, { mode: 'hitl', seedCatalog: false });
  db.upsertSku(box);
  db.insertSoldComps(comps(box, [1, 2, 3, 4].map(age => [age, 16_000])));
  await autopilot.ingestListingFastPath(candidate, { nowIso });
  const older = comps(box, [[20, 20_000], [30, 20_000]]);
  db.insertSoldComps(older);
  assert.equal((await autopilot.runAutonomousTriage({ nowIso })).rejectedCount, 1);
  assert.equal(db.listOrders()[0].status, 'rejected');

  const seeded = setup(t, { mode: 'hitl' });
  const scenario = (await connectors[0].fetchListings([])).find(listing => listing.listingId === 'mock-zard-raw-nm')!;
  await seeded.autopilot.ingestListingFastPath({ ...scenario, imageUrls: scenario.imageUrls.slice(0, 1) });
  const summary = await seeded.autopilot.runAutonomousTriage();
  assert.equal(summary.heldCount, 1);
  assert.match(summary.actions[0].reason ?? '', /two photos/);
});

test('fulfillment chooses vault, direct, and close buylist exits and repricing clamps exactly to floor profit', async t => {
  const runtime = setup(t);
  const { autopilot, db, inventoryManager, connectors, config } = runtime;
  const listings = await connectors[0].fetchListings([]);
  const inventory = async (listingId: string) => {
    const result = await autopilot.ingestListingFastPath(listings.find(item => item.listingId === listingId)!);
    assert.equal(result.execution?.status, 'filled');
    return result.execution!.inventoryItem!;
  };
  const raw = await inventory('mock-lugia-cgc10-clean');
  const sealed = await inventory('mock-ssp-bb-clean');
  assert.equal(autopilot.recommendFulfillmentRoute(raw.id).route, 'vault_consignment');
  assert.equal(autopilot.recommendFulfillmentRoute(sealed.id).route, 'direct_marketplace');
  const defaultBuylistMultiplier = config.exitFeeSchedules.buylist.priceMultiplier;
  config.exitFeeSchedules.buylist.priceMultiplier = 0.94;
  assert.equal(autopilot.recommendFulfillmentRoute(sealed.id).route, 'buylist_instant');
  config.exitFeeSchedules.buylist.priceMultiplier = defaultBuylistMultiplier;

  const exit = inventoryManager.recommendExit(sealed.id).channels[0];
  db.updateInventoryItem(sealed.id, {
    acquiredAt: new Date(Date.now() - 15 * dayMs).toISOString(), costBasisCents: exit.netProceedsCents - 510,
  });
  inventoryManager.recordIntakeQc(sealed.id, { passed: true, actualCondition: 'SEALED' });
  const repricing = autopilot.runRepricingCycle();
  assert.equal(repricing.repricedCount, 1);
  const [action] = repricing.actions;
  assert.equal(action.expectedNetProfitCents, 500);
  assert.ok(action.listedPriceCents < exit.expectedExitPriceCents);
  assert.equal(db.getInventoryItem(sealed.id)?.status, 'listed');
  assert.equal(db.getInventoryItem(sealed.id)?.listedPriceCents, action.listedPriceCents);
  assert.equal(autopilot.runRepricingCycle().repricedCount, 0);
  assert.equal(db.getInventoryItem(raw.id)?.status, 'in_transit');
});

async function listen(t: TestContext, server: ReturnType<typeof createArbitrageServer>): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('loopback HTTP accepts validated push listings and exposes Buy Book, telemetry, and autopilot passes', async t => {
  const runtime = setup(t, { mode: 'shadow' });
  const url = await listen(t, createArbitrageServer(runtime));
  const post = (path: string, body: unknown, origin = url) => fetch(url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });
  const webhook = '/api/webhooks/listing';
  const data = { title: 'Surging Spaks Boster Box', listingId: 'push-box', priceCents: 9500, seller: candidate.seller };
  assert.equal((await post(webhook, data, 'https://untrusted.example')).status, 403);
  for (const patch of [{ title: '  ' }, { priceCents: 0 }, { priceCents: 1.5 }, { shippingCents: -3 }, { imageUrls: [1] }]) {
    assert.equal((await post(webhook, { ...data, ...patch })).status, 400);
  }
  const first = await post(webhook, data);
  assert.equal(first.status, 200);
  const outcome = await first.json();
  assert.equal(outcome.execution.status, 'shadow_recorded');
  assert.equal(outcome.recovery.recovered, true);
  assert.equal((await (await post(webhook, data)).json()).deduplicated, true);
  assert.equal((await (await post(webhook, { ...data, force: true })).json()).execution.status, 'duplicate');
  const book = await (await fetch(url + '/api/buy-book?tier=standard&refresh=true')).json();
  assert.ok(book.some((entry: { skuId: string }) => entry.skuId === 'sealed-ssp-bb'));
  const telemetry = await (await fetch(url + '/api/telemetry')).json();
  assert.equal(telemetry.fuzzyRecoveriesCount, 2);
  assert.equal(telemetry.samplesCount, 2);
  assert.ok(telemetry.detectToDecision.p99Ms >= telemetry.detectToDecision.p50Ms);
  assert.equal((await post('/api/autopilot/pass', { tier: 'unknown' })).status, 400);
  const pass = await post('/api/autopilot/pass', { tier: 'all' });
  assert.equal(pass.status, 200);
  assert.equal((await pass.json()).cycle.fetchedCount, 17);
  const legacy = await listen(t, createArbitrageServer({ ...runtime, autopilot: undefined }));
  assert.equal((await fetch(legacy + '/api/buy-book')).status, 501);
  assert.equal((await fetch(legacy + '/api/telemetry')).status, 501);
  for (const path of [webhook, '/api/autopilot/pass']) {
    assert.equal((await fetch(legacy + path, { method: 'POST', body: '{}' })).status, 501);
  }
});

test('autopilot CLI prints a complete one-pass summary', () => {
  const cli = spawnSync(process.execPath, ['src/cli.ts', 'autopilot', '--mock', '--once'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    env: { ...process.env, ARBITRAGE_DB_PATH: ':memory:', ARBITRAGE_MODE: 'shadow' },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, '');
  for (const line of ['Buy Book tiers', 'Cycle totals (shadow)', 'Autonomous triage', 'Repricing and vault routing', 'Latency telemetry']) {
    assert.ok(cli.stdout.includes(line), line);
  }
});

test('concurrent pushes deduplicate unchanged listings and keep checkout idempotent on forced retries', async t => {
  const { autopilot, db } = setup(t, { seedCatalog: false });
  db.upsertSku(box);
  db.insertSoldComps(comps(box, Array.from({ length: 10 }, (_, i) => [i + 1, 16_000])));
  const outcomes = await Promise.all([
    autopilot.ingestListingFastPath(candidate, { nowIso }), autopilot.ingestListingFastPath(candidate, { nowIso }),
  ]);
  assert.equal(outcomes.filter(result => result.deduplicated).length, 1);
  assert.equal(outcomes.filter(result => result.execution?.status === 'filled').length, 1);
  assert.equal((await autopilot.ingestListingFastPath(candidate, {
    nowIso, skipDeduplication: true,
  })).execution?.status, 'duplicate');
  assert.equal(db.listOrders().length, 1);
  assert.equal(db.listInventory().length, 1);
});

test('daemon stops scheduling and drains a priority scan already in flight', { timeout: 2000 }, async t => {
  const runtime = setup(t, { seedCatalog: false, mode: 'shadow' });
  const { db, connectors } = runtime;
  const autopilot = new AutopilotEngine(runtime, { nowFn: () => new Date(nowIso) });
  t.after(() => autopilot.stopDaemon());
  db.upsertSku(box);
  db.insertSoldComps(comps(box, Array.from({ length: 10 }, (_, i) => [i + 1, 16_000])));
  let started!: () => void;
  let release!: () => void;
  const fetching = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fetches = 0;
  connectors[0] = {
    ...connectors[0], isEnabled: () => true,
    async fetchListings() {
      fetches++;
      started();
      await gate;
      return [candidate];
    },
  };
  autopilot.startDaemon({ hotIntervalMs: 1, standardIntervalMs: 1000, repriceIntervalMs: 1000 });
  await fetching;
  autopilot.stopDaemon();
  const idle = autopilot.waitForIdle();
  assert.deepEqual(db.listOrders(), []);
  release();
  await idle;
  assert.equal(fetches, 1);
  assert.equal(db.listOrders()[0].status, 'shadow_recorded');
  assert.equal(db.getSystemState().lastScanAt, nowIso);
});
