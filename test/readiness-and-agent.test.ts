import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { seedStarterSkus } from '../src/catalog/seed.ts';
import { createSystemRuntime } from '../src/cli.ts';
import { EbayBrowseConnector } from '../src/connectors/ebayConnector.ts';
import { MockScenarioConnector } from '../src/connectors/mockScenarioConnector.ts';
import { ShopifyStorefrontConnector } from '../src/connectors/retailerConnectors.ts';
import { evaluateReadiness } from '../src/engine/readiness.ts';
import type { ReadinessReport } from '../src/engine/readiness.ts';
import { loadProjectEnv } from '../src/env.ts';
import { EbayOrderApiExecutor, ExecutionCoordinator } from '../src/execution/executor.ts';
import { evaluateSellerTrust } from '../src/matching/redFlags.ts';
import { createArbitrageServer } from '../src/server/httpServer.ts';

const serviceKeys = [
  'ARBITRAGE_MODE', 'ARBITRAGE_SKIP_DOTENV', 'ARBITRAGE_WEBHOOK_URL',
  'EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_REFRESH_TOKEN', 'EBAY_ACCESS_TOKEN', 'EBAY_ORDER_API_TOKEN',
  'POKEMON_TCG_API_KEY', 'PRICECHARTING_API_TOKEN', 'EBAY_INSIGHTS_ENABLED',
  'BESTBUY_API_KEY', 'COSTCO_FEED_URL', 'POKEMON_CENTER_FEED_URL', 'LGS_SHOPIFY_DOMAINS', 'TCGPLAYER_API_TOKEN',
  'PSA_API_TOKEN', 'VISION_API_KEY', 'VISION_API_URL',
];

function setEnv(t: TestContext, values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function tempDirectory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'arbitrage-agent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('live eBay can recommend auto-buy with unknown age and still rejects weak feedback', async t => {
  const runtime = createSystemRuntime({ dbPath: ':memory:', mode: 'live', useMock: true });
  t.after(() => runtime.db.close());
  const sku = runtime.db.getSku('sealed-ssp-bb');
  assert.ok(sku);
  const item = {
    itemId: 'v1|100|0', title: sku.name + ' Factory Sealed', gtin: sku.upc,
    itemWebUrl: 'https://www.ebay.com/itm/100', price: { value: '95.00', currency: 'USD' },
    shippingOptions: [{ shippingCost: { value: '0.00', currency: 'USD' } }],
    seller: { username: 'card-store', feedbackScore: 500, feedbackPercentage: '99.6' },
  };
  const connector = new EbayBrowseConnector({
    accessToken: 'browse-fixture',
    fetchFn: async () => Response.json({ itemSummaries: [
      item, { ...item, itemId: 'v1|101|0', seller: { ...item.seller, feedbackScore: 5 } },
    ] }),
  });
  const [trusted, weak] = await connector.fetchListings([sku]);
  assert.equal(trusted.seller.accountAgeUnknown, true);
  const trust = evaluateSellerTrust(trusted.seller, runtime.config);
  assert.equal(trust.trusted, true);
  assert.ok(trust.score < 1);
  assert.deepEqual(trust.reasons, ['Seller does not accept returns']);
  for (const accountAgeUnknown of [undefined, false]) {
    assert.equal(evaluateSellerTrust({ ...trusted.seller, accountAgeUnknown }, runtime.config).trusted, false);
  }
  assert.equal(evaluateSellerTrust({ ...trusted.seller, positivePercent: 95 }, runtime.config).trusted, false);
  assert.equal((await runtime.pipeline.evaluateListing(trusted)).decision.action, 'auto_buy');
  assert.equal(evaluateSellerTrust(weak.seller, runtime.config).trusted, false);
  assert.equal((await runtime.pipeline.evaluateListing(weak)).decision.action, 'skip');
});

test('an authorized Shopify storefront passes seller trust and reaches manual review', async t => {
  const runtime = createSystemRuntime({ dbPath: ':memory:', mode: 'live', useMock: true });
  t.after(() => runtime.db.close());
  const sku = runtime.db.getSku('sealed-ssp-bb');
  assert.ok(sku);
  const connector = new ShopifyStorefrontConnector({
    storeDomain: 'cards.example.test',
    fetchFn: async () => Response.json({ products: [{
      title: sku.name, handle: 'surging-sparks',
      variants: [{ id: 1, title: 'Default Title', price: '95.00', available: true, barcode: sku.upc }],
    }] }),
  });
  const [listing] = await connector.fetchListings([sku]);
  assert.equal(listing.seller.sellerId, 'shopify:cards.example.test');
  assert.equal(evaluateSellerTrust(listing.seller, runtime.config).trusted, true);
  assert.equal(listing.supportsAutoCheckout, false);
  assert.equal((await runtime.pipeline.evaluateListing(listing)).decision.action, 'hitl_review');
});

test('the env loader parses supported forms, preserves the shell, and honors the skip setting', t => {
  const path = join(tempDirectory(t), '.env');
  setEnv(t, {
    ARBITRAGE_SKIP_DOTENV: '', WAVE7_EXISTING: 'shell', WAVE7_EMPTY_SHELL: '',
    WAVE7_PLAIN: undefined, WAVE7_SINGLE: undefined, WAVE7_DOUBLE: undefined,
    WAVE7_EMPTY: undefined, WAVE7_MALFORMED: undefined, WAVE7_LATER: undefined,
  });
  writeFileSync(path, [
    '# sample', '', ' export WAVE7_PLAIN = 123 # inline comment', 'WAVE7_PLAIN=duplicate',
    "WAVE7_SINGLE='  a#b  ' # quoted comment", 'WAVE7_DOUBLE="a=b#c"',
    'WAVE7_EMPTY= # blank value', 'WAVE7_EXISTING=file', 'WAVE7_EMPTY_SHELL=file', 'malformed',
    'WAVE7_MALFORMED="unclosed', 'WAVE7_LATER=present',
  ].join('\r\n'));
  const missing = path + '.missing';
  assert.deepEqual(loadProjectEnv(missing), { loaded: false, path: missing, keysLoaded: 0 });
  process.env.ARBITRAGE_SKIP_DOTENV = '1';
  assert.deepEqual(loadProjectEnv(path), { loaded: false, path, keysLoaded: 0 });
  process.env.ARBITRAGE_SKIP_DOTENV = '';
  assert.deepEqual(loadProjectEnv(path), { loaded: true, path, keysLoaded: 5 });
  assert.equal(process.env.WAVE7_EXISTING, 'shell');
  assert.equal(process.env.WAVE7_EMPTY_SHELL, '');
  assert.equal(process.env.WAVE7_PLAIN, '123');
  assert.equal(process.env.WAVE7_SINGLE, '  a#b  ');
  assert.equal(process.env.WAVE7_DOUBLE, 'a=b#c');
  assert.equal(process.env.WAVE7_EMPTY, '');
  assert.equal(process.env.WAVE7_MALFORMED, undefined);
  assert.equal(process.env.WAVE7_LATER, 'present');
});

test('starter bootstrap is repeatable and adds no comparable sales', t => {
  const { db } = createSystemRuntime({ dbPath: ':memory:', useMock: true, seedCatalog: false });
  t.after(() => db.close());
  const now = new Date('2026-11-26T00:00:00Z');
  assert.deepEqual(seedStarterSkus(db, now), { skusSeeded: 20 });
  assert.deepEqual(seedStarterSkus(db, now), { skusSeeded: 20 });
  const skus = db.listSkus();
  assert.equal(skus.length, 20);
  assert.ok(skus.every(sku => sku.createdAt === now.toISOString() && db.getSoldComps(sku.id).length === 0));
});

test('readiness reports unconfigured blockers, fresh comps, live checkout, and kill switch state', t => {
  setEnv(t, Object.fromEntries(serviceKeys.map(key => [key, undefined])));
  const unconfigured = createSystemRuntime({ dbPath: ':memory:' });
  t.after(() => unconfigured.db.close());
  const blocked = evaluateReadiness(unconfigured);
  assert.equal(blocked.readyForShadowScan, false);
  assert.equal(blocked.readyForLiveAutoBuy, false);
  assert.equal(blocked.checkoutCapability, 'manual_only');
  assert.deepEqual(blocked.enabledConnectors, []);
  assert.equal(blocked.disabledConnectors.length, 6);
  assert.equal(blocked.disabledSyncers.length, 3);
  assert.ok(blocked.blockingIssues.some(issue => /catalog is empty/i.test(issue)));
  assert.ok(blocked.recommendedNextActions.some(action => action.includes('bootstrap_catalog')));

  Object.assign(process.env, {
    EBAY_CLIENT_ID: 'browse-id', EBAY_CLIENT_SECRET: 'browse-secret', EBAY_ORDER_API_TOKEN: 'member-token',
    PRICECHARTING_API_TOKEN: 'price-token', PSA_API_TOKEN: 'psa-token', VISION_API_KEY: 'vision-key',
    VISION_API_URL: 'https://vision.example.test/v1', ARBITRAGE_WEBHOOK_URL: 'https://hooks.example.test',
  });
  const nowIso = '2026-11-26T00:00:00.000Z';
  const live = createSystemRuntime({ dbPath: ':memory:', mode: 'live', envFileLoaded: true });
  t.after(() => live.db.close());
  seedStarterSkus(live.db, new Date(nowIso));
  live.db.insertSoldComps([1, 2, 3].map(index => ({
    id: 'comp-' + index, skuId: 'sealed-ssp-bb', source: 'ebay', soldPriceCents: 16_500,
    shippingCents: 0, totalPriceCents: 16_500, condition: 'SEALED', soldAt: nowIso,
  })));
  const ready = evaluateReadiness(live, { nowIso });
  assert.deepEqual(ready.enabledConnectors, ['eBay Browse']);
  assert.deepEqual(ready.enabledSyncers, ['PriceCharting']);
  assert.equal(ready.checkoutCapability, 'ebay_static_token');
  assert.equal(ready.certVerifier, 'psa_live');
  assert.equal(ready.visionVerifier, 'openai_live');
  assert.equal(ready.webhookAlertingEnabled, true);
  assert.equal(ready.envFileLoaded, true);
  assert.equal(ready.freshCompSkuCount, 1);
  assert.equal(ready.staleCompSkuCount, 19);
  assert.equal(ready.readyForShadowScan, true);
  assert.equal(ready.readyForHitlAlerts, true);
  assert.equal(ready.readyForLiveAutoBuy, true);
  assert.deepEqual(ready.blockingIssues, []);
  assert.equal(evaluateReadiness(live, { nowIso: '2027-01-01T00:00:00.000Z' }).freshCompSkuCount, 0);

  process.env.EBAY_REFRESH_TOKEN = 'member-refresh';
  assert.equal(evaluateReadiness(live, { nowIso }).checkoutCapability, 'ebay_oauth_live');
  live.db.setOperatingMode('hitl');
  assert.equal(evaluateReadiness(live, { nowIso }).readyForHitlAlerts, true);
  assert.equal(evaluateReadiness(live, { nowIso }).readyForLiveAutoBuy, false);
  live.db.setKillSwitch(true, 'Operator pause');
  const stopped = evaluateReadiness(live, { nowIso });
  assert.equal(stopped.killSwitchReason, 'Operator pause');
  assert.equal(stopped.readyForShadowScan, false);
  assert.equal(stopped.readyForHitlAlerts, false);
});

test('static member checkout uses its Order token alongside Browse OAuth credentials', async t => {
  setEnv(t, {
    EBAY_CLIENT_ID: 'browse-id', EBAY_CLIENT_SECRET: 'browse-secret',
    EBAY_REFRESH_TOKEN: undefined, EBAY_ORDER_API_TOKEN: 'member-token',
  });
  const runtime = createSystemRuntime({ dbPath: ':memory:', mode: 'live', useMock: true });
  t.after(() => runtime.db.close());
  let browseTokenRequests = 0;
  let orderRequests = 0;
  const adapter = new EbayOrderApiExecutor({
    fetchFn: async (input, init) => {
      const { pathname } = new URL(String(input));
      const token = new Headers(init?.headers).get('Authorization');
      const usd = (value: string) => ({ value, currency: 'USD' });
      if (pathname === '/identity/v1/oauth2/token') {
        assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'client_credentials');
        browseTokenRequests++;
        return Response.json({ access_token: 'browse-token', expires_in: 3600 });
      }
      if (pathname.includes('/browse/')) {
        assert.equal(token, 'Bearer browse-token');
        return Response.json({
          price: usd('95.00'), shippingOptions: [{ shippingCost: usd('0.00') }],
          buyingOptions: ['FIXED_PRICE'], estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }],
        });
      }
      assert.match(pathname, /^\/buy\/order\//);
      assert.equal(token, 'Bearer member-token');
      orderRequests++;
      return pathname.endsWith('/initiate')
        ? Response.json({ checkoutSessionId: 'session', pricingSummary: { total: usd('102.60') } })
        : Response.json({ purchaseOrderId: 'fixture-order', purchaseOrderPaymentStatus: 'PAID' });
    },
  });
  const [fixture] = await new MockScenarioConnector().fetchListings([]);
  const listing = { ...fixture, source: 'ebay' } as const;
  const { decision } = await runtime.pipeline.evaluateListing(listing, { persistDecision: true });
  const coordinator = new ExecutionCoordinator({ db: runtime.db, config: runtime.config, adapter });
  const result = await coordinator.executeDecision(decision, listing);
  assert.equal(result.status, 'filled', result.reason);
  assert.equal(result.order?.externalOrderId, 'fixture-order');
  assert.equal(browseTokenRequests, 1);
  assert.equal(orderRequests, 2);
});

test('GET /api/readiness reports the attached runtime and changes in persisted state', async t => {
  const runtime = createSystemRuntime({ dbPath: ':memory:', mode: 'live', useMock: true, envFileLoaded: true });
  const server = createArbitrageServer(runtime);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = 'http://127.0.0.1:' + address.port + '/api/readiness';
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(evaluateReadiness(runtime))));
    runtime.db.setKillSwitch(true, 'HTTP readiness test');
    const report = await (await fetch(url)).json() as ReadinessReport;
    assert.equal(report.killSwitchReason, 'HTTP readiness test');
    assert.equal(report.readyForLiveAutoBuy, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    runtime.db.close();
  }
});

test('CLI doctor and bootstrap emit JSON and doctor loads the working directory env file', t => {
  const cwd = tempDirectory(t);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const env = { ...process.env };
  for (const key of serviceKeys) delete env[key];
  writeFileSync(join(cwd, '.env'), 'ARBITRAGE_MODE=hitl\n');
  const run = (command: string, ...flags: string[]): unknown =>
    JSON.parse(execFileSync(process.execPath, [cli, command, '--db', ':memory:', ...flags], { cwd, env, encoding: 'utf8' }));
  const report = run('doctor', '--json') as ReadinessReport;
  assert.equal(report.dbPath, ':memory:');
  assert.equal(report.envFileLoaded, true);
  assert.equal(report.operatingMode, 'hitl');
  assert.equal(report.catalogSkuCount, 0);
  assert.equal(report.readyForLiveAutoBuy, false);
  env.ARBITRAGE_SKIP_DOTENV = '1';
  const mock = run('doctor', '--mock', '--json') as ReadinessReport;
  assert.equal(mock.envFileLoaded, false);
  assert.equal(mock.operatingMode, 'shadow');
  assert.equal(mock.checkoutCapability, 'simulated');
  assert.deepEqual(run('bootstrap'), { skusSeeded: 20, compsSeeded: 0, nextAction: 'npm run sync' });
});

test('MCP keeps a mode change across CLI launches when there is no startup mode override', t => {
  const cwd = tempDirectory(t);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const env = { ...process.env };
  delete env.ARBITRAGE_MODE;
  const run = (name: string, args = {}) => JSON.parse(execFileSync(process.execPath, [
    cli, 'mcp', '--mock', '--db', 'data/test.sqlite',
  ], {
    cwd, env, encoding: 'utf8',
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
  })).result.structuredContent;
  assert.equal(run('check_readiness').operatingMode, 'shadow');
  assert.equal(run('set_operating_mode', { mode: 'live' }).operatingMode, 'live');
  assert.equal(run('check_readiness').operatingMode, 'live');
});
