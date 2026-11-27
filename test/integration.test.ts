import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createSystemRuntime } from '../src/cli.ts';
import type { SystemRuntimeOptions } from '../src/cli.ts';
import type { SupplyConnector } from '../src/connectors/base.ts';
import { percentOfCents } from '../src/domain/money.ts';
import type { InventoryItem, RawListing } from '../src/domain/types.ts';
import { createArbitrageServer } from '../src/server/httpServer.ts';
import type { ArbitrageServerOptions } from '../src/server/httpServer.ts';

function runtime(t: TestContext, options: SystemRuntimeOptions = {}) {
  const system = createSystemRuntime({
    dbPath: ':memory:', mode: 'live', useMock: true, seedCatalog: true, quiet: true, ...options,
    configOverrides: { dailySpendCapCents: 150_000, ...options.configOverrides },
  });
  t.after(() => {
    system.pipeline.stopLoop();
    system.db.close();
  });
  return system;
}

function pending(system: ReturnType<typeof runtime>, listingId: string) {
  const order = system.db.listOrders('pending_hitl').find(candidate => candidate.listingId === listingId);
  assert.ok(order, `Expected pending order for ${listingId}`);
  return order;
}

async function listen(t: TestContext, options: ArbitrageServerOptions) {
  const server = createArbitrageServer(options);
  t.after(async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('dry-run evaluation returns a decision without persisting or marking the listing seen', async t => {
  const system = runtime(t);
  const { db, pipeline, connectors } = system;
  const [listing] = await connectors[0].fetchListings(db.listSkus());

  const result = await pipeline.evaluateListing(listing);
  assert.equal(result.match.status, 'matched');
  assert.equal(result.valuation?.skuId, 'sealed-ssp-bb');
  assert.equal(result.decision.action, 'auto_buy');
  assert.deepEqual(db.listDecisions(), []);
  assert.deepEqual(db.listOrders(), []);
  assert.equal(db.hasUnchangedListing(listing.source, listing.listingId, listing.priceCents, listing.quantity), false);

  const persisted = await pipeline.evaluateListing(listing, { persistDecision: true });
  assert.equal(db.listDecisions()[0].id, persisted.decision.id);
});

test('live mock scan fills two orders, queues six reviews, and deduplicates all 17 unchanged listings', async t => {
  const system = runtime(t);
  const { db, pipeline } = system;
  const first = await pipeline.runCycle();
  assert.deepEqual({
    fetched: first.fetchedCount, matched: first.matchedCount, rejected: first.rejectedCount,
    filled: first.autoBoughtCount, queued: first.hitlQueuedCount, skipped: first.skippedCount, errors: first.errors,
  }, { fetched: 17, matched: 13, rejected: 4, filled: 2, queued: 6, skipped: 9, errors: [] });

  const filled = db.listOrders('filled');
  assert.deepEqual(filled.map(order => order.skuId).sort(), ['graded-cgc10-swsh12-186', 'sealed-ssp-bb']);
  assert.ok(filled.every(order => order.externalOrderId?.startsWith('sim-')));
  assert.equal(filled.reduce((sum, order) => sum + order.landedCostCents, 0), 41_540);
  assert.deepEqual(db.listInventory().map(item => item.skuId).sort(), ['graded-cgc10-swsh12-186', 'sealed-ssp-bb']);
  for (const [id, warning] of [
    ['mock-pre-etb-retailer', /sanctioned automated checkout/],
    ['mock-moonbreon-psa10-highcap', /single-order limit/],
    ['mock-zard-raw-nm', /photo\/condition/],
    ['mock-evs-bb-anomaly', /anomaly/i],
    ['mock-costco-151-tins', /sanctioned automated checkout/],
    ['mock-pc-pre-etb', /anomaly/i],
  ] as const) {
    assert.ok(pending(system, id).decisionWarnings.some(text => warning.test(text)));
  }
  assert.ok(pending(system, 'mock-costco-151-tins').decisionWarnings.every(warning => !/anomaly/i.test(warning)));
  const skipped = new Map(db.listDecisions(-1, 'skip').map(decision => [decision.listingId, decision]));
  assert.deepEqual([...skipped.keys()].sort(), [
    'mock-151-thin-margin', 'mock-crz-sketchy-seller', 'mock-digital-code-trap', 'mock-evs-empty-box',
    'mock-snap-illiquid', 'mock-zard-006-holo', 'mock-zard-cert-mismatch', 'mock-zard-jp-sv2a', 'mock-zard-proxy-trap',
  ]);
  assert.equal(skipped.get('mock-zard-jp-sv2a')?.skuId, 'raw-jp-sv2a-201');
  assert.equal(skipped.get('mock-zard-006-holo')?.skuId, 'raw-en-sv3pt5-006-holo');

  const second = await pipeline.runCycle();
  assert.equal(second.fetchedCount, 17);
  assert.equal(second.deduplicatedCount, 17);
  assert.equal(second.autoBoughtCount, 0);
  assert.equal(db.listOrders().length, 8);
  assert.equal(db.listDecisions().length, 17);
  assert.equal(db.getSystemState().lastScanAt, second.finishedAt);
  assert.equal(db.listAuditEvents().filter(event => event.eventType === 'cycle.completed').length, 2);
});

test('the $1,000 daily cap blocks Moonbreon after both clean orders fill', async t => {
  const { db, pipeline } = runtime(t, { configOverrides: { dailySpendCapCents: 100_000 } });
  const summary = await pipeline.runCycle();
  assert.equal(summary.autoBoughtCount, 2);
  assert.equal(summary.hitlQueuedCount, 5);
  const decision = db.listDecisions(-1, 'skip').find(candidate => candidate.listingId === 'mock-moonbreon-psa10-highcap');
  assert.equal(decision?.reasons[0], 'Daily spend cap exceeded');
});

test('the kill switch blocks all purchases and pending reviews on a fresh scan', async t => {
  const { db, pipeline } = runtime(t);
  db.setKillSwitch(true, 'Operator stop');
  const summary = await pipeline.runCycle();
  assert.equal(summary.autoBoughtCount, 0);
  assert.equal(summary.hitlQueuedCount, 0);
  assert.equal(summary.skippedCount, 17);
  assert.deepEqual(db.listOrders(), []);
  assert.ok(db.listDecisions().every(decision => /Kill switch engaged/.test(decision.reasons[0])));
});

test('the circuit breaker counts consecutive failures, resets on success, and blocks later listings in its trip cycle', async t => {
  const { db, pipeline, connectors } = runtime(t, { configOverrides: { circuitBreakerMaxErrorsPerWindow: 3 } });
  const failing: SupplyConnector = {
    name: 'Broken feed', source: 'ebay', supportsAutoCheckout: false, pollIntervalMs: 1,
    isEnabled: () => true, fetchListings: async () => { throw new Error('Connection lost'); },
  };
  const empty: SupplyConnector = { ...failing, name: 'Healthy feed', fetchListings: async () => [] };

  assert.equal((await pipeline.runCycle({ connectors: [failing] })).errorCount, 1);
  await pipeline.runCycle({ connectors: [empty] });
  assert.equal(db.getSystemState().consecutiveErrors, 0);

  for (let count = 1; count < 3; count++) {
    const summary = await pipeline.runCycle({ connectors: [failing] });
    assert.deepEqual(summary.errors, ['Broken feed: Connection lost']);
    assert.equal(summary.killSwitchTriggered, false);
    assert.equal(db.getSystemState().consecutiveErrors, count);
  }
  const summary = await pipeline.runCycle({ connectors: [failing, ...connectors] });
  assert.equal(summary.killSwitchTriggered, true);
  assert.equal(summary.autoBoughtCount, 0);
  assert.equal(summary.skippedCount, 17);
  assert.equal(db.getSystemState().consecutiveErrors, 3);
  assert.match(db.getSystemState().killSwitchReason ?? '', /Circuit breaker/);
});

test('the scan loop coalesces overlapping requests and stops scheduling after stopLoop', async t => {
  const { pipeline, connectors } = runtime(t);
  let calls = 0;
  let complete!: (listings: RawListing[]) => void;
  const fetched = new Promise<RawListing[]>(resolve => { complete = resolve; });
  const connector: SupplyConnector = {
    name: 'Slow feed', source: 'mock_feed', supportsAutoCheckout: false, pollIntervalMs: 100,
    isEnabled: () => true, fetchListings: () => { calls++; return fetched; },
  };
  connectors.splice(0, 1, connector);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pipeline.startLoop(100);
  t.mock.timers.tick(100);
  assert.equal(calls, 1);
  const active = pipeline.runCycle();
  assert.equal(pipeline.runCycle(), active);
  t.mock.timers.tick(500);
  assert.equal(calls, 1);
  pipeline.stopLoop();
  complete([]);
  await pipeline.waitForIdle();
  t.mock.timers.tick(500);
  assert.equal(calls, 1);
});

test('HITL requires anomaly confirmation and supports approval and rejection', async t => {
  const system = runtime(t);
  const { db, pipeline } = system;
  await pipeline.runCycle();
  const anomaly = pending(system, 'mock-evs-bb-anomaly');
  const retailer = pending(system, 'mock-pre-etb-retailer');
  const blocked = await pipeline.approveHitlOrder(anomaly.id);
  assert.equal(blocked.status, 'aborted');
  assert.match(blocked.reason ?? '', /confirmAnomaly=true/);
  assert.equal(db.getOrder(anomaly.id)?.status, 'pending_hitl');

  db.setOperatingMode('shadow');
  const shadow = await pipeline.approveHitlOrder(anomaly.id, { confirmAnomaly: true });
  assert.equal(shadow.status, 'aborted');
  assert.match(shadow.reason ?? '', /shadow mode/);
  db.setOperatingMode('live');

  const approved = await pipeline.approveHitlOrder(anomaly.id, { confirmAnomaly: true });
  assert.equal(approved.status, 'filled');
  assert.equal(approved.inventoryItem?.skuId, 'sealed-evs-bb');
  assert.equal((await pipeline.approveHitlOrder(anomaly.id, { confirmAnomaly: true })).status, 'aborted');

  const lockKey = `${retailer.source}:${retailer.listingId}`;
  assert.equal(db.acquirePurchaseLock(lockKey, 'other-worker', 5000), true);
  assert.equal(pipeline.rejectHitlOrder(retailer.id, 'Checkout in progress'), undefined);
  assert.equal(db.getOrder(retailer.id)?.status, 'pending_hitl');
  db.releasePurchaseLock(lockKey, 'other-worker');

  const rejected = pipeline.rejectHitlOrder(retailer.id, 'Retailer stock unavailable');
  assert.equal(rejected?.status, 'rejected');
  assert.equal(rejected.failureReason, 'Retailer stock unavailable');
  assert.equal(pipeline.rejectHitlOrder(retailer.id, 'Duplicate action'), undefined);
  assert.ok(db.listAuditEvents().some(event => event.eventType === 'order.hitl_approved'));
  assert.ok(db.listAuditEvents().some(event => event.eventType === 'order.hitl_rejected'));
});

test('failed execution is counted and leaves a failed order without inventory', async t => {
  const { db, pipeline } = runtime(t, {
    simulationOverrides: { 'mock-ssp-bb-clean': { failureReason: 'Payment declined' } },
  });
  const summary = await pipeline.runCycle();
  assert.equal(summary.autoBoughtCount, 1);
  assert.deepEqual(summary.errors, ['mock_feed:mock-ssp-bb-clean: Payment declined']);
  assert.equal(db.listOrders('failed')[0].failureReason, 'Payment declined');
  assert.deepEqual(db.listInventory().map(item => item.skuId), ['graded-cgc10-swsh12-186']);
});

test('inventory tracks QC, one-time acquisition costs, listing, sale, and realized forecast variance', async t => {
  const { db, config, pipeline, inventoryManager } = runtime(t);
  await pipeline.runCycle();
  const sealed = db.listInventory().find(item => item.assetClass === 'sealed');
  const graded = db.listInventory().find(item => item.assetClass === 'graded');
  assert.ok(sealed && graded);

  assert.equal(inventoryManager.recordIntakeQc(sealed.id, { passed: true, actualCondition: 'SEALED' }).status, 'qc_passed');
  assert.equal(inventoryManager.recordIntakeQc(graded.id, {
    passed: true, actualCondition: 'LP', notes: 'Intake wear',
  }).status, 'qc_disputed');
  const exit = inventoryManager.recommendExit(sealed.id);
  assert.ok(exit.expectedFmvCents > 0);
  assert.equal(exit.channels.length, 4);
  assert.equal(exit.recommendedChannel, exit.channels[0].exitChannel);
  for (const channel of exit.channels) {
    assert.equal(channel.estimatedTaxCents, 0);
    assert.equal(channel.landedCostCents, sealed.costBasisCents);
    assert.equal(channel.netProfitCents, channel.netProceedsCents - sealed.costBasisCents - channel.riskReserveCents);
    assert.ok(Number.isSafeInteger(channel.netProfitCents));
  }

  assert.equal(inventoryManager.markListed(sealed.id, exit.recommendedChannel, 16_000).status, 'listed');
  const sale = inventoryManager.recordSale(sealed.id, { exitChannel: 'ebay', soldPriceCents: 16_000 });
  const fees = percentOfCents(16_000, config.exitFeeSchedules.ebay.percentFee) + config.exitFeeSchedules.ebay.fixedFeeCents +
    config.outboundShippingCents.sealed + config.packagingCents.sealed;
  const realized = 16_000 - fees - sealed.costBasisCents;
  assert.equal(sale.exitFeesCents, fees);
  assert.equal(sale.realizedProfitCents, realized);
  assert.throws(() => inventoryManager.recordSale(sealed.id, { exitChannel: 'ebay', soldPriceCents: 16_000 }), /already sold/);

  assert.deepEqual(inventoryManager.getPnLAttribution(), {
    totalItems: 2, soldItems: 1, activeItems: 0, disputedCount: 1,
    totalCostBasisCents: sealed.costBasisCents + graded.costBasisCents,
    totalPredictedProfitCents: sealed.predictedNetProfitCents + graded.predictedNetProfitCents,
    totalRealizedProfitCents: realized,
    realizedVsPredictedDeltaCents: realized - sealed.predictedNetProfitCents,
  });
});

test('HTTP dashboard supports scan, HITL, controls, and inventory workflows with validated inputs', async t => {
  const system = runtime(t);
  const base = await listen(t, system);
  const get = (path: string) => fetch(base + path);
  const post = (path: string, body: unknown) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await page.text(), /Pokémon Arbitrage &amp; HITL Control Dashboard/);
  assert.deepEqual(await (await get('/api/health')).json(), { status: 'ok' });
  assert.equal((await (await get('/api/state')).json()).systemState.operatingMode, 'live');
  assert.equal((await post('/api/scan', {})).status, 200);
  assert.equal((await (await get('/api/state')).json()).pendingHitlCount, 6);
  assert.equal((await (await get('/api/orders')).json()).length, 8);
  assert.equal((await (await get('/api/decisions?action=skip')).json()).length, 9);
  assert.ok((await (await get('/api/audit')).json()).some((event: { eventType: string }) => event.eventType === 'cycle.completed'));

  const anomaly = pending(system, 'mock-evs-bb-anomaly');
  const retailer = pending(system, 'mock-pre-etb-retailer');
  const approve = '/api/orders/' + anomaly.id + '/approve';
  assert.equal((await post(approve, { confirmAnomaly: 'true' })).status, 400);
  const unconfirmed = await post(approve, {});
  assert.equal(unconfirmed.status, 409);
  assert.match((await unconfirmed.json()).error, /confirmAnomaly=true/);
  assert.equal((await post(approve, { confirmAnomaly: true })).status, 200);
  assert.equal((await post(approve, { confirmAnomaly: true })).status, 409);
  const rejected = await post('/api/orders/' + retailer.id + '/reject', { reason: 'No stock' });
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).status, 'rejected');
  assert.equal((await post('/api/orders/unknown/approve', {})).status, 404);

  assert.equal((await post('/api/kill-switch', { engaged: 1 })).status, 400);
  assert.equal((await (await post('/api/kill-switch', { engaged: true, reason: 'Operator stop' })).json()).killSwitchEngaged, true);
  assert.equal((await (await post('/api/kill-switch', { engaged: false })).json()).killSwitchEngaged, false);
  assert.equal((await post('/api/mode', { mode: 'invalid' })).status, 400);
  const invalidJson = await fetch(base + '/api/mode', { method: 'POST', body: '{' });
  assert.equal(invalidJson.status, 400);
  const oversized = await post('/api/mode', { mode: 'x'.repeat(65_536) });
  assert.equal(oversized.status, 413);
  const crossOrigin = await fetch(base + '/api/mode', {
    method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'shadow' }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await (await post('/api/mode', { mode: 'hitl' })).json()).operatingMode, 'hitl');

  const items = await (await get('/api/inventory')).json() as InventoryItem[];
  assert.equal(items.length, 3);
  const item = items.find(candidate => candidate.skuId === 'sealed-ssp-bb');
  assert.ok(item);
  const inventory = '/api/inventory/' + item.id;
  assert.equal((await post(inventory + '/qc', { passed: true, actualCondition: 'NEW' })).status, 400);
  const passed = await post(inventory + '/qc', { passed: true, actualCondition: 'SEALED' });
  assert.equal(passed.status, 200);
  assert.equal((await passed.json()).status, 'qc_passed');
  const recommendation = await get(inventory + '/recommend-exit');
  assert.equal(recommendation.status, 200);
  assert.equal((await recommendation.json()).channels.length, 4);
  assert.equal((await get('/api/inventory/unknown/recommend-exit')).status, 404);
  assert.equal((await post(inventory + '/sell', { exitChannel: 'ebay', soldPriceCents: 10.5 })).status, 400);
  const sale = await post(inventory + '/sell', { exitChannel: 'ebay', soldPriceCents: 18_000, exitFeesCents: 1000 });
  assert.equal(sale.status, 200);
  assert.equal((await sale.json()).realizedProfitCents, 18_000 - 1000 - item.costBasisCents);
  assert.equal((await post(inventory + '/sell', { exitChannel: 'ebay', soldPriceCents: 18_000 })).status, 409);
  assert.equal((await post('/mcp', {})).status, 501);
});

test('HTTP MCP delegation forwards the payload and headers and preserves the handler response', async t => {
  const system = runtime(t);
  const base = await listen(t, {
    ...system,
    mcpHandler: async (payload, headers) => ({
      status: 202, headers: { 'Mcp-Session-Id': 'session' }, body: { payload, accept: headers?.accept },
    }),
  });
  const response = await fetch(base + '/mcp', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0' }),
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('mcp-session-id'), 'session');
  assert.deepEqual(await response.json(), { payload: { jsonrpc: '2.0' }, accept: 'application/json' });
});
