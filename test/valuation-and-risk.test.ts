import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { seedCanonicalCatalog } from '../src/catalog/seed.ts';
import { createConfig } from '../src/config.ts';
import type { ArbitrageConfig } from '../src/config.ts';
import { ArbitrageDatabase } from '../src/db/database.ts';
import { RiskEngine } from '../src/decision/riskEngine.ts';
import type { RiskDecisionInput } from '../src/decision/riskEngine.ts';
import type { ArbitrageDecision, CanonicalSku, ExitChannel, RawListing, SoldComp } from '../src/domain/types.ts';
import { FmvEngine } from '../src/valuation/fmvEngine.ts';
import { calculateNetProfit, evaluateExitChannels } from '../src/valuation/profitCalculator.ts';

const NOW = '2026-11-26T12:00:00.000Z';
const MS_PER_DAY = 86_400_000;
const SURGING_SPARKS = 'sealed-ssp-bb';
const CHARIZARD = 'raw-en-sv3pt5-199';
const UMBREON_SLAB = 'graded-psa10-swsh07-215';
const CONFIG = createConfig({
  operatingMode: 'shadow',
  minCompCount: 3,
  staleCompMaxAgeDays: 21,
  minLiquidityScore: 0.30,
  minMatchConfidence: 0.80,
  minNetProfitCents: 1500,
  minNetRoi: 0.15,
  maxAnomalyDiscount: 0.60,
  allowRawAutoBuy: false,
  autoBuyMaxOrderCents: 50000,
  dailySpendCapCents: 100000,
  maxPositionPerSku: 5,
  cashBalanceCents: 500000,
  minCashReserveCents: 50000,
  salesTaxRate: 0.08,
});
const fmvEngine = new FmvEngine();
const riskEngine = new RiskEngine();

function seedDb(t: TestContext): ArbitrageDatabase {
  const db = new ArbitrageDatabase(':memory:');
  t.after(() => db.close());
  seedCanonicalCatalog(db, new Date(NOW));
  return db;
}

function getSku(db: ArbitrageDatabase, skuId: string): CanonicalSku {
  const sku = db.getSku(skuId);
  assert.ok(sku, `Expected seed SKU ${skuId}`);
  return sku;
}

function soldAt(ageDays: number): string {
  return new Date(Date.parse(NOW) - ageDays * MS_PER_DAY).toISOString();
}

function soldComp(sku: CanonicalSku, totalPriceCents: number, ageDays: number, id: number): SoldComp {
  return {
    id: `synthetic-${id}`,
    skuId: sku.id,
    source: 'ebay',
    soldPriceCents: totalPriceCents,
    shippingCents: 0,
    totalPriceCents,
    condition: sku.assetClass === 'sealed' ? 'SEALED' : 'NM',
    grader: sku.grader,
    grade: sku.grade,
    soldAt: soldAt(ageDays),
  };
}

function listingFor(sku: CanonicalSku, priceCents: number): RawListing {
  return {
    listingId: `listing-${sku.id}`,
    source: 'mock_feed',
    title: sku.name,
    description: sku.name,
    url: `https://example.test/${sku.id}`,
    priceCents,
    shippingCents: 0,
    quantity: 1,
    currency: 'USD',
    imageUrls: [],
    seller: {
      sellerId: 'trusted-seller',
      username: 'trusted-seller',
      feedbackScore: 250,
      positivePercent: 99.8,
      accountAgeDays: 730,
      returnsAccepted: true,
    },
    supportsAutoCheckout: true,
    listedAt: NOW,
    fetchedAt: NOW,
  };
}

function riskInput(
  db: ArbitrageDatabase,
  skuId = SURGING_SPARKS,
  askCents = 9500,
  config: ArbitrageConfig = CONFIG,
): RiskDecisionInput {
  const sku = getSku(db, skuId);
  return {
    listing: listingFor(sku, askCents),
    match: {
      status: 'matched',
      skuId,
      canonicalSku: sku,
      confidence: 0.98,
      sellerTrust: { trusted: true, score: 1, reasons: [] },
      redFlags: [],
      blockingRedFlags: [],
      reasons: ['Catalog match verified'],
    },
    valuation: fmvEngine.evaluate(sku, db.getSoldComps(skuId), config, { nowIso: NOW }),
    portfolio: db.getPortfolioSnapshot(config, NOW),
    systemState: db.setOperatingMode('live'),
    config,
    nowIso: NOW,
  };
}

function assertSkipped(decision: ArbitrageDecision, reason: string): void {
  assert.equal(decision.action, 'skip');
  assert.equal(decision.intendedAction, 'skip');
  assert.ok(decision.reasons.includes(reason), JSON.stringify(decision.reasons));
}

test('statistically trims both seeded raw Charizard outliers with all outlier labels stripped', t => {
  const db = seedDb(t);
  const sku = getSku(db, CHARIZARD);
  const comps: SoldComp[] = db.getSoldComps(sku.id).map(comp => ({ ...comp, isOutlier: undefined }));
  const inlier = comps.find(comp => comp.condition === 'NM' && comp.totalPriceCents === 22512);
  assert.ok(inlier);
  inlier.isOutlier = true;
  const result = fmvEngine.evaluate(sku, comps, CONFIG, { nowIso: NOW });

  assert.equal(result.compCount, 12);
  assert.equal(result.trimmedCompCount, 10);
  assert.equal(result.rawMedianCents, 21000);
  assert.equal(result.trimmedMinCents, 19488);
  assert.equal(result.trimmedMaxCents, 22512);
  assert.ok(result.fmvCents >= 20000 && result.fmvCents <= 22000);
  assert.equal(result.isStale, false);
  assert.match(result.reasons.join(' '), /Trimmed 2 statistical price outlier/);
});

test('statistically trims the seeded sealed bundle outlier and filters SKU and condition', t => {
  const db = seedDb(t);
  const sku = getSku(db, 'sealed-151-bundle');
  const comps = [
    ...db.getSoldComps(sku.id).map(comp => ({ ...comp, isOutlier: undefined })),
    ...db.getSoldComps(SURGING_SPARKS),
    { ...soldComp(sku, 5400, 1, 0), condition: 'NM' as const },
  ];
  const result = fmvEngine.evaluate(sku, comps, CONFIG, { nowIso: NOW, condition: 'LP' });

  assert.equal(result.compCount, 11);
  assert.equal(result.trimmedCompCount, 10);
  assert.equal(result.trimmedMinCents, 5104);
  assert.equal(result.trimmedMaxCents, 5896);
  assert.equal(result.valuationCondition, 'SEALED');
  assert.ok(result.fmvCents >= 5200 && result.fmvCents <= 5800);
});

test('falls back to the median absolute deviation when the core prices are identical', t => {
  const sku = getSku(seedDb(t), SURGING_SPARKS);
  const comps = [4000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 30000]
    .map((price, index) => soldComp(sku, price, index + 1, index));
  const result = fmvEngine.evaluate(sku, comps, CONFIG, { nowIso: NOW });

  assert.equal(result.trimmedCompCount, 7);
  assert.equal(result.rawMedianCents, 10000);
  assert.equal(result.trimmedMinCents, 10000);
  assert.equal(result.trimmedMaxCents, 10000);
  assert.equal(result.priceStdDevCents, 0);
  assert.equal(result.fmvCents, 10000);
});

for (const [label, olderPrice, newerPrice] of [['increase', 10000, 14000], ['decrease', 14000, 10000]] as const) {
  test(`time-decay weighted median follows a recent price ${label}`, t => {
    const sku = getSku(seedDb(t), SURGING_SPARKS);
    const comps = [43, 38, 30, 5, 1].map((age, index) => soldComp(sku, index < 3 ? olderPrice : newerPrice, age, index));
    const result = fmvEngine.evaluate(sku, comps, CONFIG, { nowIso: NOW });

    assert.equal(result.rawMedianCents, olderPrice);
    assert.equal(result.fmvCents, newerPrice);
    assert.equal(result.trimmedCompCount, 5);
    assert.equal(result.trailing30dCount, 3);
    assert.equal(result.medianDaysToSell, 10);
    assert.equal(result.priceStdDevCents, 1960);
    assert.equal(result.newestCompAt, soldAt(1));
  });
}

test('clamps future sale weights to the current timestamp', t => {
  const sku = getSku(seedDb(t), SURGING_SPARKS);
  const comps = [
    soldComp(sku, 10000, 30, 0),
    soldComp(sku, 10000, 0, 1),
    soldComp(sku, 14000, -14, 2),
  ];
  const result = fmvEngine.evaluate(sku, comps, CONFIG, { nowIso: NOW });
  assert.equal(result.fmvCents, 10000);
  assert.equal(result.trailing30dCount, 2);
});

test('seeded vintage promo has stale comps and low liquidity', t => {
  const db = seedDb(t);
  const sku = getSku(db, 'raw-en-vintage-promo-snap');
  const result = fmvEngine.evaluate(sku, db.getSoldComps(sku.id), CONFIG, { nowIso: NOW });
  assert.equal(result.compCount, 2);
  assert.equal(result.newestCompAt, soldAt(33));
  assert.equal(result.trailing30dCount, 0);
  assert.equal(result.medianDaysToSell, 60);
  assert.ok(result.liquidityScore < CONFIG.minLiquidityScore);
  assert.equal(result.isStale, true);
  assert.match(result.reasons.join(' '), /freshness limit/);
});

test('high recent sales velocity increases liquidity and price dispersion reduces it', t => {
  const sku = getSku(seedDb(t), SURGING_SPARKS);
  const steadySales = Array.from({ length: 10 }, (_, index) => soldComp(sku, 15000, index + 1, index));
  const volatileSales = steadySales.map((_, index) => soldComp(sku, index % 2 === 0 ? 5000 : 25000, index + 1, index));
  const steady = fmvEngine.evaluate(sku, steadySales, CONFIG, { nowIso: NOW });
  const volatile = fmvEngine.evaluate(sku, volatileSales, CONFIG, { nowIso: NOW });
  const thin = fmvEngine.evaluate(sku, steadySales.slice(0, 2), CONFIG, { nowIso: NOW });

  assert.ok(steady.liquidityScore > 0.9 && steady.liquidityScore <= 1);
  assert.equal(volatile.trailing30dCount, steady.trailing30dCount);
  assert.ok(volatile.liquidityScore < steady.liquidityScore / 2);
  assert.ok(thin.liquidityScore < CONFIG.minLiquidityScore);
});

test('segments raw Charizard comps by default NM, explicit LP, and explicit SEALED', t => {
  const db = seedDb(t);
  const sku = getSku(db, CHARIZARD);
  const sealedComp = { ...soldComp(sku, 25000, 2, 0), condition: 'SEALED' as const };
  const comps = [...db.getSoldComps(sku.id), sealedComp];
  const nm = fmvEngine.evaluate(sku, comps, CONFIG, { nowIso: NOW });
  const lp = fmvEngine.evaluate(sku, comps, CONFIG, { nowIso: NOW, condition: 'LP' });
  const sealed = fmvEngine.evaluate(sku, comps, CONFIG, { nowIso: NOW, condition: 'SEALED' });

  assert.equal(nm.valuationCondition, 'NM');
  assert.equal(nm.compCount, 12);
  assert.equal(lp.valuationCondition, 'LP');
  assert.equal(lp.compCount, 7);
  assert.ok(lp.trimmedMaxCents < nm.trimmedMinCents);
  assert.equal(sealed.valuationCondition, 'SEALED');
  assert.equal(sealed.compCount, 1);
  assert.equal(sealed.fmvCents, 25000);
});

test('uses the graded SKU identity and falls back to options for missing grader or grade', t => {
  const db = seedDb(t);
  const sku = getSku(db, UMBREON_SLAB);
  const comps = [
    ...db.getSoldComps(sku.id),
    { ...soldComp(sku, 140000, 1, 0), grader: 'CGC' as const },
    { ...soldComp(sku, 65000, 1, 1), grade: '9' },
  ];
  const canonical = fmvEngine.evaluate(sku, comps, CONFIG, { nowIso: NOW, grader: 'CGC', grade: '9' });
  const withOptions = fmvEngine.evaluate({ ...sku, grader: undefined, grade: undefined }, comps, CONFIG,
    { nowIso: NOW, grader: 'CGC', grade: '10' });
  assert.equal(canonical.compCount, 10);
  assert.equal(canonical.valuationGrade, '10');
  assert.equal(withOptions.compCount, 1);
  assert.equal(withOptions.fmvCents, 140000);
});

test('a recent outlier does not refresh old core comps', t => {
  const sku = getSku(seedDb(t), SURGING_SPARKS);
  const comps = [
    soldComp(sku, 10000, 40, 0),
    soldComp(sku, 10000, 35, 1),
    soldComp(sku, 10000, 31, 2),
    soldComp(sku, 90000, 1, 3),
  ];
  const result = fmvEngine.evaluate(sku, comps, CONFIG, { nowIso: NOW });
  assert.equal(result.trimmedCompCount, 3);
  assert.equal(result.newestCompAt, soldAt(31));
  assert.equal(result.trailing30dCount, 0);
  assert.equal(result.isStale, true);
});

test('an empty segment yields zero valuation and a stale reason', t => {
  const sku = getSku(seedDb(t), SURGING_SPARKS);
  const result = fmvEngine.evaluate(sku, [], CONFIG, { nowIso: NOW });
  assert.equal(result.fmvCents, 0);
  assert.equal(result.rawMedianCents, 0);
  assert.equal(result.trimmedMinCents, 0);
  assert.equal(result.trimmedMaxCents, 0);
  assert.equal(result.newestCompAt, undefined);
  assert.equal(result.liquidityScore, 0);
  assert.equal(result.isStale, true);
  assert.ok(result.reasons.includes('No eligible sold comps'));
});

const EXIT_CASES = [
  { channel: 'ebay', price: 16503, fee: 2217, proceeds: 13236, profit: 2366 },
  { channel: 'tcgplayer', price: 16503, fee: 2134, proceeds: 13319, profit: 2449 },
  { channel: 'cardmarket', price: 16503, fee: 825, proceeds: 14628, profit: 3758 },
  { channel: 'buylist', price: 11882, fee: 0, proceeds: 10832, profit: -38 },
] as const;

for (const { channel, price, fee, proceeds, profit } of EXIT_CASES) {
  test(`calculates exact integer-cent profit on ${channel}`, t => {
    const sku = getSku(seedDb(t), SURGING_SPARKS);
    const listing = { ...listingFor(sku, 9503), shippingCents: 499, quantity: 3 };
    assert.deepEqual(calculateNetProfit(listing, 16503, sku.assetClass, channel, CONFIG), {
      exitChannel: channel,
      askPriceCents: 9503,
      inboundShippingCents: 499,
      estimatedTaxCents: 760,
      landedCostCents: 10762,
      expectedExitPriceCents: price,
      exitFeeCents: fee,
      outboundShippingCents: 850,
      packagingCents: 200,
      netProceedsCents: proceeds,
      riskReserveCents: 108,
      netProfitCents: profit,
      netRoi: profit / 10762,
      discountToFmv: 7000 / 16503,
    });
  });
}

test('ranks every exit from highest to lowest net profit', t => {
  const sku = getSku(seedDb(t), SURGING_SPARKS);
  const listing = listingFor(sku, 9503);
  const ordering: ExitChannel[] = ['cardmarket', 'tcgplayer', 'ebay', 'buylist'];
  const { bestExit, allExits } = evaluateExitChannels(listing, 16503, sku.assetClass, CONFIG);
  assert.deepEqual(allExits.map(exit => exit.exitChannel), ordering);
  assert.deepEqual(bestExit, allExits[0]);
});

test('auto-buys a clean $95 Surging Sparks booster box in live mode and persists integer cents', t => {
  const db = seedDb(t);
  const input = riskInput(db);
  const decision = riskEngine.decide(input);
  assert.equal(decision.action, 'auto_buy');
  assert.equal(decision.intendedAction, 'auto_buy');
  assert.equal(decision.operatingMode, 'live');
  assert.equal(decision.anomalyFlagged, false);
  assert.equal(decision.listingId, input.listing.listingId);
  assert.equal(decision.skuId, SURGING_SPARKS);
  assert.equal(decision.decidedAt, NOW);
  assert.ok(decision.bestExit);
  assert.equal(decision.allExits?.length, 4);
  db.saveDecision(decision);
  assert.deepEqual(db.listDecisions(), [decision]);
});

test('flags a $210 Evolving Skies booster box and escalates the anomaly in live mode', t => {
  const decision = riskEngine.decide(riskInput(seedDb(t), 'sealed-evs-bb', 21000));
  assert.equal(decision.intendedAction, 'hitl_review');
  assert.equal(decision.action, 'hitl_review');
  assert.equal(decision.anomalyFlagged, true);
  assert.match(decision.warnings.join(' '), /Anomaly: discount exceeds threshold/);
});

test('requires photo and condition review for profitable raw singles with raw auto-buy disabled', t => {
  const input = riskInput(seedDb(t), CHARIZARD, 13000);
  const decision = riskEngine.decide(input);
  assert.equal(decision.intendedAction, 'hitl_review');
  assert.equal(decision.action, 'hitl_review');
  assert.ok(decision.warnings.includes('Raw single requires human photo/condition verification'));

  const rawEnabled = riskEngine.decide({ ...input, config: { ...CONFIG, allowRawAutoBuy: true } });
  assert.equal(rawEnabled.action, 'auto_buy');
});

test('requires human review when the source lacks automated checkout', t => {
  const input = riskInput(seedDb(t));
  input.listing.supportsAutoCheckout = false;
  input.match.redFlags.push('Listing photo shows glare');
  const decision = riskEngine.decide(input);
  assert.equal(decision.intendedAction, 'hitl_review');
  assert.equal(decision.action, 'hitl_review');
  assert.deepEqual(decision.warnings, [
    'Listing photo shows glare',
    'Source does not support sanctioned automated checkout',
  ]);
  assert.deepEqual(input.match.redFlags, ['Listing photo shows glare']);
});

test('escalates the $820 certified Umbreon slab above the $500 order limit', t => {
  const input = riskInput(seedDb(t), UMBREON_SLAB, 82000);
  input.match.certVerification = { checked: true, valid: true };
  const decision = riskEngine.decide(input);
  assert.equal(decision.intendedAction, 'hitl_review');
  assert.equal(decision.action, 'hitl_review');
  assert.deepEqual(decision.warnings, ['Order cost exceeds auto-buy single-order limit']);
});

test('requires human review for an unverified graded certification within the order limit', t => {
  const input = riskInput(seedDb(t), 'graded-cgc10-swsh12-186', 25000);
  input.match.certVerification = { checked: true, valid: false };
  const decision = riskEngine.decide(input);
  assert.equal(decision.intendedAction, 'hitl_review');
  assert.equal(decision.action, 'hitl_review');
  assert.deepEqual(decision.warnings, ['Graded slab lacks verified certification lookup']);
});

test('skips when the portfolio daily spend cap would be exceeded', t => {
  const input = riskInput(seedDb(t));
  input.portfolio.dailySpendCents = 40000;
  input.portfolio.dailySpendCapCents = 50000;
  assertSkipped(riskEngine.decide(input), 'Daily spend cap exceeded');
});

test('skips when listing quantity would exceed the per-SKU position limit', t => {
  const input = riskInput(seedDb(t));
  input.listing.quantity = 2;
  input.portfolio.skuPositions[SURGING_SPARKS] = 4;
  assertSkipped(riskEngine.decide(input), 'Per-SKU max position limit reached');
});

test('skips when landed cost would breach the portfolio cash reserve floor', t => {
  const input = riskInput(seedDb(t));
  input.portfolio.cashBalanceCents = 60000;
  assertSkipped(riskEngine.decide(input), 'Cash reserve floor breached');
});

test('permits landed cost and position exactly at portfolio limits', t => {
  const input = riskInput(seedDb(t));
  input.portfolio.dailySpendCents = input.portfolio.dailySpendCapCents - 10260;
  input.portfolio.cashBalanceCents = input.portfolio.minCashReserveCents + 10260;
  input.portfolio.skuPositions[SURGING_SPARKS] = CONFIG.maxPositionPerSku - 1;
  assert.equal(riskEngine.decide(input).action, 'auto_buy');
});

test('kill switch takes priority over catalog and valuation checks', t => {
  const db = seedDb(t);
  const input = riskInput(db);
  input.systemState = db.setKillSwitch(true, 'Upstream checkout errors');
  input.match.status = 'rejected';
  input.valuation = undefined;
  assertSkipped(riskEngine.decide(input), 'Kill switch engaged (Upstream checkout errors)');
  input.systemState = db.setKillSwitch(true);
  assertSkipped(riskEngine.decide(input), 'Kill switch engaged');
});

test('rejects unmatched listings and listings with blocking match flags', t => {
  const input = riskInput(seedDb(t));
  input.match.status = 'unmatched';
  input.match.canonicalSku = undefined;
  input.match.reasons = ['No SKU matched'];
  assertSkipped(riskEngine.decide(input), 'No SKU matched');

  const blocked = riskInput(seedDb(t));
  blocked.match.blockingRedFlags.push('Possible counterfeit');
  assertSkipped(riskEngine.decide(blocked), 'Possible counterfeit');
});

test('skips untrusted sellers and matches below the confidence threshold', t => {
  const input = riskInput(seedDb(t));
  input.match.sellerTrust = { trusted: false, score: 0.2, reasons: ['Too little seller feedback'] };
  assertSkipped(riskEngine.decide(input), 'Too little seller feedback');

  input.match.sellerTrust.trusted = true;
  input.match.confidence = 0.79;
  assertSkipped(riskEngine.decide(input), 'Match confidence 0.79 is below minimum 0.8');
});

test('skips missing, nonpositive, stale, and illiquid valuations', t => {
  const input = riskInput(seedDb(t));
  const { valuation } = input;
  assert.ok(valuation);
  assertSkipped(riskEngine.decide({ ...input, valuation: undefined }), 'Stale or insufficient sold comps');
  assertSkipped(riskEngine.decide({ ...input, valuation: { ...valuation, fmvCents: 0 } }), 'Stale or insufficient sold comps');
  assertSkipped(riskEngine.decide({ ...input, valuation: { ...valuation, isStale: true } }), 'Stale or insufficient sold comps');
  assertSkipped(riskEngine.decide({ ...input, valuation: { ...valuation, liquidityScore: 0.25 } }), 'Liquidity score below minimum');
});

test('reports the exact minimum profit and ROI failures and retains exit calculations', t => {
  const input = riskInput(seedDb(t), SURGING_SPARKS, 12500);
  assert.ok(input.valuation);
  input.valuation.fmvCents = 16500;
  const decision = riskEngine.decide(input);
  assertSkipped(decision, 'Net profit $9.90 is below minimum $15.00');
  assert.equal(decision.bestExit?.netProfitCents, 990);
  assert.ok(decision.reasons.some(reason => /^Net ROI 7\.33.*% is below minimum 15%$/.test(reason)));
});

test('HITL mode keeps the intended auto-buy and queues human review', t => {
  const input = riskInput(seedDb(t));
  input.systemState.operatingMode = 'hitl';
  const decision = riskEngine.decide(input);
  assert.equal(decision.operatingMode, 'hitl');
  assert.equal(decision.intendedAction, 'auto_buy');
  assert.equal(decision.action, 'hitl_review');
  assert.ok(decision.reasons.includes('Operating mode is HITL; auto-buy downgraded to human review'));
});

test('shadow mode preserves both auto-buy and review outcomes and marks paper trading', t => {
  const input = riskInput(seedDb(t));
  input.systemState.operatingMode = 'shadow';
  for (const intendedAction of ['auto_buy', 'hitl_review'] as const) {
    input.listing.supportsAutoCheckout = intendedAction === 'auto_buy';
    const decision = riskEngine.decide(input);
    assert.equal(decision.operatingMode, 'shadow');
    assert.equal(decision.intendedAction, intendedAction);
    assert.equal(decision.action, intendedAction);
    assert.ok(decision.reasons.includes('Shadow mode active: paper-trading only'));
  }
});
