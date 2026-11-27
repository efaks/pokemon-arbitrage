import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { seedCanonicalCatalog } from '../src/catalog/seed.ts';
import { createConfig } from '../src/config.ts';
import { ArbitrageDatabase } from '../src/db/database.ts';
import { ageInDays, clamp, daysBetween, formatUsd, percentOfCents, toCents } from '../src/domain/money.ts';
import type { ArbitrageDecision, InventoryItem, OrderStatus, ProfitBreakdown, PurchaseOrder } from '../src/domain/types.ts';

const NOW = '2026-11-26T12:00:00.000Z';
const TODAY = '2026-11-26T00:00:00.000Z';
const YESTERDAY = '2026-11-25T23:59:59.999Z';
const SKU_ID = 'sealed-151-bundle';

function openDb(t: TestContext, dbPath = ':memory:'): ArbitrageDatabase {
  const db = new ArbitrageDatabase(dbPath);
  t.after(() => db.close());
  return db;
}

function tempDatabasePath(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'pokemon-arbitrage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'nested', 'arbitrage.sqlite');
}

function seedDb(t: TestContext): ArbitrageDatabase {
  const db = openDb(t);
  seedCanonicalCatalog(db, new Date(NOW));
  return db;
}

function decision(id: string, decidedAt = NOW): ArbitrageDecision {
  return {
    id: `decision-${id}`,
    listingId: id,
    source: 'mock_feed',
    listingUrl: `https://example.test/${id}`,
    listingTitle: '151 Booster Bundle',
    skuId: SKU_ID,
    skuName: 'Pokemon 151 Booster Bundle',
    assetClass: 'sealed',
    action: 'hitl_review',
    intendedAction: 'hitl_review',
    operatingMode: 'hitl',
    matchConfidence: 0.97,
    fmvCents: 5500,
    liquidityScore: 0.65,
    warnings: ['manual review'],
    reasons: ['matched by UPC'],
    anomalyFlagged: false,
    decidedAt,
  };
}

function order(db: ArbitrageDatabase, id: string, status: OrderStatus, quantity = 1, createdAt = NOW): PurchaseOrder {
  const saved = decision(id, createdAt);
  db.saveDecision(saved);
  return {
    id,
    idempotencyKey: `key-${id}`,
    decisionId: saved.id,
    listingId: saved.listingId,
    source: saved.source,
    listingUrl: saved.listingUrl,
    listingTitle: saved.listingTitle,
    skuId: SKU_ID,
    skuName: 'Pokemon 151 Booster Bundle',
    assetClass: 'sealed',
    status,
    quantity,
    askPriceCents: 2800,
    shippingCents: 100,
    taxCents: 100,
    landedCostCents: 3000 * quantity,
    expectedNetProfitCents: 700 * quantity,
    expectedNetRoi: 0.23,
    recommendedExitChannel: 'ebay',
    decisionWarnings: ['manual review'],
    createdAt,
    updatedAt: createdAt,
  };
}

function inventory(id: string, orderId: string, status: InventoryItem['status']): InventoryItem {
  return {
    id,
    orderId,
    skuId: SKU_ID,
    skuName: 'Pokemon 151 Booster Bundle',
    assetClass: 'sealed',
    expectedCondition: 'SEALED',
    costBasisCents: 3000,
    expectedExitChannel: 'ebay',
    expectedFmvCents: 5500,
    predictedNetProfitCents: 700,
    status,
    acquiredAt: NOW,
    updatedAt: NOW,
  };
}

test('initializes an in-memory database with a single default system state', t => {
  const db = openDb(t);
  assert.deepEqual(db.listSkus(), []);
  assert.deepEqual(db.listOrders(), []);
  const state = db.getSystemState();
  assert.equal(state.operatingMode, 'shadow');
  assert.equal(state.killSwitchEngaged, false);
  assert.equal(state.consecutiveErrors, 0);
  assert.ok(Number.isFinite(Date.parse(state.updatedAt)));
});

test('creates parent directories, enables file-backed WAL, and persists across connections', t => {
  const path = tempDatabasePath(t);
  const db = openDb(t, path);
  const initialSkus = seedCanonicalCatalog(db, new Date(NOW)).skusSeeded;
  const reopened = openDb(t, path);

  assert.ok(existsSync(path));
  assert.equal(reopened.listSkus().length, initialSkus);
  const inspector = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(inspector.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(inspector.prepare('SELECT COUNT(*) AS count FROM system_state').get()?.count, 1);
  } finally {
    inspector.close();
  }

  const [comp] = db.getSoldComps(SKU_ID);
  assert.throws(() => db.insertSoldComps([
    { ...comp, id: 'valid-but-rolled-back' },
    { ...comp, id: 'orphan', skuId: 'missing' },
  ]), /FOREIGN KEY/);
  assert.ok(reopened.getSoldComps(SKU_ID).every(({ id }) => id !== 'valid-but-rolled-back'));
});

test('seeds deterministic comps and leaves their timestamps intact on a later run', t => {
  const db = openDb(t);
  const result = seedCanonicalCatalog(db, new Date(NOW));
  assert.deepEqual(result, { skusSeeded: 18, compsSeeded: 182 });
  const savedComps = db.listSkus().flatMap(sku => db.getSoldComps(sku.id));
  assert.equal(savedComps.length, result.compsSeeded);
  assert.ok(savedComps.every(comp => comp.totalPriceCents === comp.soldPriceCents + comp.shippingCents));
  assert.ok(savedComps.every(comp => {
    const age = ageInDays(comp.soldAt, NOW);
    return age >= 0 && age <= 60;
  }));
  assert.equal(savedComps.filter(comp => comp.isOutlier).length, 3);

  assert.deepEqual(seedCanonicalCatalog(db, new Date('2026-11-27T12:00:00.000Z')), {
    skusSeeded: result.skusSeeded,
    compsSeeded: 0,
  });
  assert.equal(db.listSkus().length, result.skusSeeded);
  assert.deepEqual(db.listSkus().flatMap(sku => db.getSoldComps(sku.id)), savedComps);

  const lp = db.getSoldComps('raw-en-sv3pt5-199', 'LP');
  const nm = db.getSoldComps('raw-en-sv3pt5-199', 'NM').filter(comp => !comp.isOutlier);
  assert.equal(lp.length, 7);
  assert.equal(nm.length, 10);
  assert.ok(Math.max(...lp.map(comp => comp.totalPriceCents)) < Math.min(...nm.map(comp => comp.totalPriceCents)));
  assert.equal(db.getSoldComps('graded-cgc10-swsh12-186', 'NM', 'CGC', '10').length, 10);
  assert.equal(db.getSoldComps('graded-cgc10-swsh12-186', undefined, 'PSA').length, 0);

  const vintage = db.getSoldComps('raw-en-vintage-promo-snap');
  assert.equal(vintage.length, 2);
  assert.ok(vintage.every(comp => ageInDays(comp.soldAt, NOW) > 30));
});

test('looks up exact UPCs, filters SKUs, and preserves SKU creation time on update', t => {
  const db = seedDb(t);
  const sku = db.findSkuByUpc('820650853210');
  assert.equal(sku?.id, SKU_ID);
  assert.equal(db.findSkuByUpc('000000000000'), undefined);
  assert.equal(db.listSkus({ assetClass: 'sealed' }).length, 5);
  const [japaneseCharizard] = db.listSkus({ assetClass: 'raw', language: 'JP' });
  assert.equal(japaneseCharizard?.cardNumber, '201/165');
  assert.ok(japaneseCharizard?.aliases.includes('sv2a 199/165'));

  assert.ok(sku);
  const update = { ...sku, aliases: ['Updated title'], createdAt: YESTERDAY, updatedAt: NOW };
  db.upsertSku(update);
  assert.deepEqual(db.getSku(sku.id), { ...update, createdAt: sku.createdAt });
});

test('deduplicates only unchanged listing prices and quantities within a source', t => {
  const db = openDb(t);
  assert.equal(db.hasUnchangedListing('ebay', 'listing-1', 3500, 2), false);
  db.markListingSeen('ebay', 'listing-1', 3500, 2, NOW);
  assert.equal(db.hasUnchangedListing('ebay', 'listing-1', 3500, 2), true);
  assert.equal(db.hasUnchangedListing('ebay', 'listing-1', 3501, 2), false);
  assert.equal(db.hasUnchangedListing('ebay', 'listing-1', 3500, 1), false);
  assert.equal(db.hasUnchangedListing('tcgplayer', 'listing-1', 3500, 2), false);
  db.markListingSeen('ebay', 'listing-1', 3501, 2);
  assert.equal(db.hasUnchangedListing('ebay', 'listing-1', 3500, 2), false);
  assert.equal(db.hasUnchangedListing('ebay', 'listing-1', 3501, 2), true);
});

test('purchase locks exclude other owners across connections and expire at their TTL', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const path = tempDatabasePath(t);
  const first = openDb(t, path);
  const second = openDb(t, path);

  assert.equal(first.acquirePurchaseLock('ebay:1', 'first', 1000), true);
  assert.equal(first.acquirePurchaseLock('ebay:1', 'first', 1000), false);
  assert.equal(second.acquirePurchaseLock('ebay:1', 'second', 1000), false);
  assert.equal(second.releasePurchaseLock('ebay:1', 'second'), false);
  t.mock.timers.tick(999);
  assert.equal(second.acquirePurchaseLock('ebay:1', 'second', 1000), false);
  t.mock.timers.tick(1);
  assert.equal(second.acquirePurchaseLock('ebay:1', 'second', 1000), true);
  assert.equal(first.releasePurchaseLock('ebay:1', 'first'), false);
  assert.equal(second.releasePurchaseLock('ebay:1', 'second'), true);
  assert.equal(second.releasePurchaseLock('ebay:1', 'second'), false);
  assert.equal(first.acquirePurchaseLock('ebay:1', 'first', 1000), true);
});

test('creates orders idempotently and persists targeted status patches', t => {
  const db = seedDb(t);
  const original = order(db, 'first-order', 'pending_hitl');
  assert.deepEqual(db.createOrderIdempotent(original), { order: original, created: true });
  assert.deepEqual(db.createOrderIdempotent({ ...original, id: 'another-order', status: 'approved' }), {
    order: original,
    created: false,
  });
  assert.deepEqual(db.listOrders('pending_hitl'), [original]);
  assert.equal(db.getOrder('another-order'), undefined);
  assert.deepEqual(db.getOrderByIdempotencyKey(original.idempotencyKey), original);

  const approved = db.updateOrderStatus(original.id, 'approved', { externalOrderId: 'external-42', updatedAt: NOW });
  assert.deepEqual(approved, { ...original, status: 'approved', externalOrderId: 'external-42' });
  const filled = db.updateOrderStatus(original.id, 'filled', { failureReason: undefined, updatedAt: NOW });
  assert.deepEqual(filled, { ...approved, status: 'filled' });
  assert.deepEqual(db.getOrder(original.id), filled);
  assert.equal(db.updateOrderStatus('missing', 'cancelled'), undefined);
});

test('daily spend includes committed orders and positions count open order units plus active inventory', t => {
  const db = seedDb(t);
  const statuses: OrderStatus[] = [
    'approved', 'executing', 'filled', 'shadow_recorded', 'pending_hitl', 'rejected', 'failed', 'cancelled',
  ];
  for (const status of statuses) {
    db.createOrderIdempotent(order(db, status, status, status === 'approved' ? 2 : 1, TODAY));
  }
  db.createOrderIdempotent(order(db, 'previous-day', 'filled', 1, YESTERDAY));

  db.createInventoryItem(inventory('active', 'filled', 'in_transit'));
  db.createInventoryItem(inventory('disputed', 'previous-day', 'qc_disputed'));
  db.createInventoryItem({ ...inventory('sold', 'previous-day', 'sold'), realizedProfitCents: 520, soldAt: NOW });

  assert.equal(db.getDailySpendCents(TODAY), 12000);
  assert.equal(db.getDailySpendCents(YESTERDAY), 15000);
  assert.equal(db.getSkuPositionCount(SKU_ID), 4);
  assert.equal(db.getSkuPositionCount('missing'), 0);

  const config = createConfig({ dailySpendCapCents: 20000, cashBalanceCents: 60000, minCashReserveCents: 5000 });
  const portfolio = db.getPortfolioSnapshot(config, NOW);
  assert.deepEqual(portfolio, {
    dailySpendCents: 12000, dailySpendCapCents: 20000, cashBalanceCents: 60000,
    minCashReserveCents: 5000, skuPositions: { [SKU_ID]: 4 },
    activeInventoryCostCents: 3000, activeInventoryCount: 1,
  });
  assert.deepEqual(db.getDashboardMetrics(config, NOW), {
    systemState: db.getSystemState(), portfolio, pendingHitlCount: 1, totalOrdersFilled: 2,
    shadowOrdersCount: 1, totalPredictedProfitCents: 2100, totalRealizedProfitCents: 520,
    soldCount: 1, recentDecisionsCount: 9,
  });
});

test('decision and inventory reads preserve JSON details and optional fields', t => {
  const db = seedDb(t);
  const exit: ProfitBreakdown = {
    exitChannel: 'ebay', askPriceCents: 2800, inboundShippingCents: 100, estimatedTaxCents: 100,
    landedCostCents: 3000, expectedExitPriceCents: 5500, exitFeeCents: 758,
    outboundShippingCents: 850, packagingCents: 200, netProceedsCents: 3692, riskReserveCents: 55,
    netProfitCents: 637, netRoi: 0.2123, discountToFmv: 0.49,
  };
  const saved = { ...decision('exits'), bestExit: exit, allExits: [exit], anomalyFlagged: true };
  db.saveDecision(saved);
  assert.deepEqual(db.listDecisions(1, 'hitl_review'), [saved]);
  assert.deepEqual(db.listDecisions(1, 'skip'), []);
  assert.throws(() => db.saveDecision({
    ...decision('fractional-exit'), allExits: [{ ...exit, netProfitCents: 637.5 }],
  }), /integer number of cents/);

  const acquired = order(db, 'acquired', 'filled');
  db.createOrderIdempotent(acquired);
  const item = inventory('item', acquired.id, 'in_transit');
  db.createInventoryItem(item);
  assert.deepEqual(db.getInventoryItem(item.id), item);
  const listed = db.updateInventoryItem(item.id, {
    status: 'listed', actualCondition: 'SEALED', listedChannel: 'ebay', listedPriceCents: 5400, updatedAt: NOW,
  });
  assert.equal(listed?.listedPriceCents, 5400);
  assert.equal(listed?.costBasisCents, 3000);
  assert.deepEqual(db.listInventory('listed'), [listed]);
  assert.equal(db.updateInventoryItem(item.id, { listedPriceCents: undefined })?.listedPriceCents, undefined);
  assert.equal(db.updateInventoryItem('missing', { status: 'sold' }), undefined);
});

test('persists and clears kill switch state and records scan errors and audit events', t => {
  const db = openDb(t);
  const enabled = db.setKillSwitch(true, 'error threshold');
  assert.equal(enabled.killSwitchEngaged, true);
  assert.equal(enabled.killSwitchReason, 'error threshold');
  assert.deepEqual(db.getSystemState(), enabled);
  assert.equal(db.setOperatingMode('hitl').operatingMode, 'hitl');
  assert.equal(db.recordScanTimestamp(NOW).lastScanAt, NOW);
  assert.equal(db.incrementConsecutiveErrors().consecutiveErrors, 1);
  assert.equal(db.incrementConsecutiveErrors().consecutiveErrors, 2);
  assert.equal(db.resetConsecutiveErrors().consecutiveErrors, 0);
  assert.deepEqual(db.setKillSwitch(false), db.getSystemState());
  assert.equal(db.getSystemState().killSwitchEngaged, false);
  assert.equal(db.getSystemState().killSwitchReason, undefined);

  const first = db.logAuditEvent('switch.engaged', { nested: { reason: 'error threshold' } });
  const second = db.logAuditEvent('switch.cleared');
  assert.deepEqual(db.listAuditEvents(), [second, first]);
  assert.deepEqual(db.listAuditEvents(1), [second]);
});

test('uses integer cents for money helpers and applies valid environment overrides', t => {
  assert.equal(formatUsd(1500), '$15.00');
  assert.equal(formatUsd(-450), '-$4.50');
  assert.equal(toCents(15.04), 1504);
  assert.equal(percentOfCents(299, 0.08), 24);
  assert.equal(clamp(10, 0, 8), 8);
  assert.equal(daysBetween(TODAY, NOW), 0.5);
  assert.equal(daysBetween(NOW, TODAY), 0.5);
  assert.equal(ageInDays(NOW, TODAY), -0.5);

  const env = {
    ...process.env,
    ARBITRAGE_MODE: 'hitl',
    ARBITRAGE_DB_PATH: ':memory:',
    ARBITRAGE_MIN_PROFIT_CENTS: '1550',
    ARBITRAGE_DAILY_CAP_CENTS: '12.5',
  };
  t.mock.property(process, 'env', env);
  const config = createConfig();
  assert.equal(config.operatingMode, 'hitl');
  assert.equal(config.dbPath, ':memory:');
  assert.equal(config.minNetProfitCents, 1550);
  assert.equal(config.dailySpendCapCents, 100000);
  assert.equal(createConfig({ operatingMode: 'shadow' }).operatingMode, 'shadow');
  assert.throws(() => createConfig({ minNetProfitCents: 15.50 }), /integer USD cents/);
});
